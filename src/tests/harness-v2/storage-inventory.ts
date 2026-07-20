import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createConversationDeletionTombstone,
  createConversationPayloadKeyV2
} from "../../harness/conversation/conversation-store";
import {
  canonicalRunRecordDigest
} from "../../harness/contracts/run-record";
import {
  RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY
} from "../../harness/ledger/run-record-retention";
import {
  commitRecordMutationJournal,
  createRecordMutationJournal,
  stageRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  scanStorageInventory,
  type ReadOnlyDirEntry,
  type ReadOnlyFs,
  type StorageInventoryOptions
} from "../../harness/records/storage-inventory";
import {
  createLocalNativeProviderProbes,
  type NativeProviderId,
  type NativeProviderProbe,
  type ReadOnlySqliteExecutor
} from "../../harness/records/native-provider-inventory";
import type { NativeExecutionRecord } from "../../harness/contracts/native-execution";
import {
  buildStorageInventoryReport,
  renderStorageInventoryMarkdown,
  serializeStorageInventoryReport,
  storageInventorySnapshotFingerprint
} from "../../harness/records/storage-inventory-report";
import {
  createStorageInventoryOpaqueRef,
  StorageInventoryContractError,
  type StorageInventoryProviderSnapshot,
  type StorageInventoryReport,
  type StorageInventoryReportInput,
  type StorageInventorySource,
  validateStorageInventoryReportInput
} from "../../harness/records/storage-inventory-contract";
import {
  runStorageInventoryCli,
  STORAGE_INVENTORY_EXIT_CODES,
  STORAGE_INVENTORY_OUTPUT_FILES
} from "../../harness/records/storage-inventory-cli";
import {
  fixtureRecordMutationRootBindings
} from "./record-root-fixtures";

const SECRET = "TOP_SECRET_BODY";
const FIXED_NOW = Date.parse("2026-07-19T00:00:00.000Z");
const PLUGIN_DIR = "codex-echoink";

export async function runHarnessV2StorageInventoryTests(): Promise<void> {
  await assertVisibleAndStoredConversationDivergence();
  await assertConversationIndexDirectoryAndCountDrift();
  await assertConversationAndHistoryRejectNonObjectIndexEntries();
  await assertConversationMetadataDirectoryDriftBlocksMigration();
  await assertUnsafeAndCollidingConversationIdsBlockMigration();
  await assertMalformedConversationDataDegradesWithoutLeakingContent();
  await assertCommittedConversationPayloadAuthorityAndMetadataOnlyBoundaries();
  await assertV2ConversationPayloadContentAddressing();
  await assertCommittedConversationPayloadPointersFailClosed();
  await assertHistoryIndexAndDuplicateMessageDrift();
  await assertHistoryV2ReferencesLinkAndNeverOwnRaw();
  await assertHistoryV2RejectsBodyFields();
  await assertRawReferenceGraphNeverReadsRawBodies();
  await assertRunLedgerIntegrityFindings();
  await assertRunEventWithoutRunIdBlocksMigration();
  await assertRunRecordRetentionJournalInventory();
  await assertNativeReplayDriftAndQuarantineCandidate();
  await assertNativeAuditProjectionNeverBecomesAuthority();
  await assertNativeSchemaAndLifecycleCompatibility();
  await assertNativeRetirementUsesConversationCommitAuthority();
  await assertDeletedNativeRetirementUsesCommittedTombstoneAuthority();
  await assertProviderUnknownIsNotMissingOrOrphaned();
  await assertIncompleteLinkedInspectionRemainsUnknown();
  await assertProviderKindMismatchRemainsAmbiguous();
  await assertUnknownProviderStatusCodeIsNormalized();
  await assertLocalProviderSqlScopeAndProjectionBoundaries();
  await assertMetadataOnlyReportsDoNotLeakBodies();
  await assertMetadataOnlyContractRejectsUnsafeValues();
  await assertScannerIsReadOnlyAndBlocksBoundarySymlinks();
  await assertReportOrderingAndFingerprintAreDeterministic();
  await assertStructuralMetadataChangesFingerprintWithStableStats();
}

async function assertRunRecordRetentionJournalInventory(): Promise<void> {
  const fixture = await createFixture(
    "echoink-storage-inventory-run-retention-"
  );
  const transactionId = "inventory-retention";
  const transactionRoot = path.join(
    fixture.pluginDataPath,
    RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY
  );
  const chainToken = `retention-${createHash("sha256")
    .update(transactionId, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
  await mkdir(path.join(transactionRoot, ".staging"), {
    recursive: true
  });
  await mkdir(path.join(transactionRoot, chainToken), {
    recursive: true
  });
  const sourceInventoryDigest = canonicalRunRecordDigest({
    subjects: []
  });
  const planDraft = {
    schemaVersion: 1,
    recordType: "run-record-retention-plan" as const,
    transactionId,
    createdAt: FIXED_NOW - 1_000,
    sourceSnapshotDigest: `sha256:${"a".repeat(64)}`,
    sourceInventoryDigest,
    subjects: [],
    actions: [],
    blockers: [],
    automaticActionAllowed: false
  };
  const plan = {
    ...planDraft,
    digest: canonicalRunRecordDigest(planDraft)
  };
  const planPath = path.join(
    transactionRoot,
    chainToken,
    "plan.json"
  );
  await writeFile(planPath, `${JSON.stringify(plan)}\n`, "utf8");

  const report = await scanAndBuild(fixture);
  const source = report.sources.find(
    (candidate) => candidate.sourceId === "run-record-retention"
  );
  assert.equal(source?.status, "scanned");
  assert.equal(source?.schemaVersion, "1");
  assert.equal(source?.recordCount, 1);
  assert.equal(
    source?.metrics?.find(
      (metric) => metric.name === "retention-transaction-count"
    )?.value,
    1
  );
  assert.equal(JSON.stringify(report).includes(transactionId), false);
  assert.equal(JSON.stringify(report).includes(transactionRoot), false);

  await writeFile(planPath, `${JSON.stringify({
    ...plan,
    digest: `sha256:${"b".repeat(64)}`
  })}\n`, "utf8");
  const corrupt = await scanAndBuild(fixture);
  assertFinding(corrupt, "run-retention-chain-corrupt");
  assert.equal(
    sourceStatus(corrupt, "run-record-retention"),
    "partial"
  );
}

async function assertVisibleAndStoredConversationDivergence(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-conversation-divergence-");
  await writeDataJson(fixture, ["conversation-a", "conversation-b"]);
  await writeConversation(fixture, "conversation-a", [message("a-message", "user")]);
  await writeConversation(fixture, "conversation-c", [message("c-message", "assistant")]);
  await writeConversationIndex(fixture, [
    conversationSummary("conversation-a", 1),
    conversationSummary("conversation-c", 1)
  ]);

  const report = await scanAndBuild(fixture);

  assertFinding(report, "data-conversation-session-missing");
  assertFinding(report, "conversation-session-unselected");
  assert.equal(report.safetyReceipt.actionsApplied, 0);
  assert.equal(report.safetyReceipt.deletionsApplied, 0);
  assert.equal(JSON.stringify(report).includes("conversation-c"), false);
  assert.ok(report.migrationPreview.candidateRecordCount > 0);
}

async function assertConversationIndexDirectoryAndCountDrift(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-conversation-index-");
  await writeDataJson(fixture, ["conversation-a"]);
  await writeConversation(fixture, "conversation-a", [
    message("a-message-1", "user"),
    message("a-message-2", "assistant")
  ]);
  await writeConversation(fixture, "conversation-unindexed", [message("unindexed-message", "user")]);
  await writeConversationIndex(fixture, [
    conversationSummary("conversation-a", 99),
    conversationSummary("conversation-missing-dir", 1)
  ]);

  const before = await directoryDigest(fixture.pluginDataPath);
  const report = await scanAndBuild(fixture);
  const after = await directoryDigest(fixture.pluginDataPath);

  assertFinding(report, "conversation-index-count-drift");
  assertFinding(report, "conversation-index-drift");
  assertFinding(report, "conversation-directory-unindexed");
  assert.equal(after, before, "conversation inventory must not repair the store during dry-run");
}

async function assertConversationAndHistoryRejectNonObjectIndexEntries(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-index-entry-shape-");
  await writeDataJson(fixture, ["knowledge-session"]);
  await writeConversation(fixture, "knowledge-session", [
    message("knowledge-message", "user")
  ], "knowledge-base");
  await writeConversationIndex(fixture, [
    conversationSummary("knowledge-session", 1, "knowledge-base"),
    "not-an-object"
  ]);
  await writeHistoryDay(fixture, "knowledge-session", "2026-07-19", [
    message("knowledge-message", "user")
  ]);
  await writeHistoryIndex(fixture, [
    historySessionSummary("knowledge-session", [
      historyDaySummary("2026-07-19", 1)
    ]),
    42
  ]);

  const report = await scanAndBuild(fixture);

  assertBlockingFinding(report, "conversation-index-entry-invalid");
  assertBlockingFinding(report, "history-index-entry-invalid");
  assert.equal(sourceStatus(report, "conversations"), "partial");
  assert.equal(sourceStatus(report, "history"), "partial");
}

async function assertConversationMetadataDirectoryDriftBlocksMigration(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-directory-id-drift-");
  await writeDataJson(fixture, ["logical-session"]);
  await writeConversation(fixture, "physical-directory", [
    message("drift-message", "user")
  ]);
  await writeJson(
    path.join(
      fixture.conversationsPath,
      "sessions",
      "physical-directory",
      "metadata.json"
    ),
    {
      id: "logical-session",
      kind: "chat",
      createdAt: 1,
      updatedAt: 2
    }
  );
  await writeConversationIndex(fixture, [
    conversationSummary("logical-session", 1)
  ]);

  const report = await scanAndBuild(fixture);

  assertBlockingFinding(report, "conversation-metadata-directory-drift");
  assert.equal(sourceStatus(report, "conversations"), "partial");
}

async function assertUnsafeAndCollidingConversationIdsBlockMigration(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-unsafe-conversation-id-");
  const unsafeA = "a/b";
  const unsafeB = "a?b";
  await writeDataJson(fixture, [unsafeA, unsafeB]);
  await writeConversation(fixture, "a-b", [
    message("unsafe-id-message", "user")
  ]);
  const metadataPath = path.join(
    fixture.conversationsPath,
    "sessions",
    "a-b",
    "metadata.json"
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  metadata.id = unsafeA;
  await writeJson(metadataPath, metadata);
  await writeConversationIndex(fixture, [
    conversationSummary(unsafeA, 1),
    conversationSummary(unsafeB, 1)
  ]);

  const report = await scanAndBuild(fixture);

  assertBlockingFinding(report, "conversation-session-id-unsafe");
  assertBlockingFinding(report, "conversation-session-id-collision");
  assertBlockingFinding(report, "conversation-metadata-directory-drift");
  assert.equal(sourceStatus(report, "conversations"), "partial");
  assert.equal(JSON.stringify(report).includes(unsafeA), false);
  assert.equal(JSON.stringify(report).includes(unsafeB), false);
}

async function assertMalformedConversationDataDegradesWithoutLeakingContent(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-corrupt-conversation-");
  await writeDataJson(fixture, ["conversation-a"]);
  await writeConversation(fixture, "conversation-a", [message("good-message", "user")]);
  await writeConversationIndex(fixture, [conversationSummary("conversation-a", 2)]);
  await writeFile(
    path.join(fixture.conversationsPath, "sessions", "conversation-a", "messages.jsonl"),
    `${JSON.stringify(message("good-message", "user"))}\n{"id":"bad-message","text":"${SECRET}"\n`,
    "utf8"
  );

  const report = await scanAndBuild(fixture);
  const serialized = serializeStorageInventoryReport(report);

  assertFinding(report, "corrupt-jsonl");
  assert.equal(sourceStatus(report, "conversations"), "partial");
  assert.doesNotMatch(serialized, new RegExp(SECRET));
}

async function assertCommittedConversationPayloadAuthorityAndMetadataOnlyBoundaries(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-context-payload-");
  const sessionId = "conversation-payload";
  const activeCommitId = "commit-active";
  const previousCommitId = "commit-previous";
  const orphanCommitId = "commit-orphaned";
  const activePayloadKey = conversationPayloadKey(activeCommitId);
  const previousPayloadKey = conversationPayloadKey(previousCommitId);
  const orphanPayloadKey = conversationPayloadKey(orphanCommitId);
  await writeDataJson(fixture, [sessionId]);
  await writeCommittedConversation(fixture, {
    sessionId,
    commitId: activeCommitId,
    payloadKey: activePayloadKey,
    previousPayloadKey,
    messages: [{
      ...message("active-message", "assistant"),
      rawRef: "raw/active-missing.txt"
    }],
    contextId: "context-active",
    generation: 3
  });
  await writeConversationIndex(fixture, [conversationSummary(sessionId, 1)]);

  const sessionPath = path.join(fixture.conversationsPath, "sessions", sessionId);
  await writeJsonl(path.join(sessionPath, "messages.jsonl"), [{
    ...message("legacy-message", "assistant"),
    rawRef: "raw/legacy-must-not-be-read.txt",
    text: "LEGACY_PAYLOAD_SENTINEL"
  }]);
  await writeJsonl(path.join(sessionPath, "snapshots.jsonl"), [{
    sessionId,
    version: "legacy-snapshot",
    rollingSummary: "LEGACY_SNAPSHOT_SENTINEL",
    sourceMessageCount: 1,
    createdAt: 1,
    updatedAt: 2
  }]);
  await writeJsonl(
    path.join(sessionPath, "context-payloads", previousPayloadKey, "messages.jsonl"),
    [{ ...message("previous-message", "assistant"), text: "PREVIOUS_PAYLOAD_SENTINEL" }]
  );
  await writeJsonl(
    path.join(sessionPath, "context-payloads", previousPayloadKey, "snapshots.jsonl"),
    [{ sessionId, version: "previous-snapshot", rollingSummary: "PREVIOUS_SNAPSHOT_SENTINEL" }]
  );
  await writeJsonl(
    path.join(sessionPath, "context-payloads", orphanPayloadKey, "messages.jsonl"),
    [{ ...message("orphan-message", "assistant"), text: "ORPHAN_PAYLOAD_SENTINEL" }]
  );
  await writeJsonl(
    path.join(sessionPath, "context-payloads", orphanPayloadKey, "snapshots.jsonl"),
    [{ sessionId, version: "orphan-snapshot", rollingSummary: "ORPHAN_SNAPSHOT_SENTINEL" }]
  );

  const forbiddenReads = new Set([
    path.join(sessionPath, "messages.jsonl"),
    path.join(sessionPath, "snapshots.jsonl"),
    path.join(sessionPath, "context-payloads", previousPayloadKey, "messages.jsonl"),
    path.join(sessionPath, "context-payloads", previousPayloadKey, "snapshots.jsonl"),
    path.join(sessionPath, "context-payloads", orphanPayloadKey, "messages.jsonl"),
    path.join(sessionPath, "context-payloads", orphanPayloadKey, "snapshots.jsonl")
  ]);
  const reads: string[] = [];
  const report = await scanAndBuild(fixture, {
    fs: readOnlyFs({
      onReadFile: (filePath) => {
        reads.push(filePath);
        if (forbiddenReads.has(filePath)) {
          throw new Error(`non-authoritative payload body read: ${filePath}`);
        }
      }
    }),
    nativeScope: "none"
  });

  assertFinding(report, "conversation-payload-unreferenced");
  assertFinding(report, "raw-reference-missing");
  assert.equal(
    report.findings.filter((finding) => finding.code === "raw-reference-missing").length,
    1,
    "only the active payload may contribute Raw references"
  );
  assert.equal(
    reads.includes(path.join(
      sessionPath,
      "context-payloads",
      activePayloadKey,
      "messages.jsonl"
    )),
    true
  );
  assert.equal(
    reads.includes(path.join(
      sessionPath,
      "context-payloads",
      activePayloadKey,
      "snapshots.jsonl"
    )),
    true
  );
  assert.equal([...forbiddenReads].some((filePath) => reads.includes(filePath)), false);
  const serialized = serializeStorageInventoryReport(report);
  for (const sentinel of [
    "LEGACY_PAYLOAD_SENTINEL",
    "LEGACY_SNAPSHOT_SENTINEL",
    "PREVIOUS_PAYLOAD_SENTINEL",
    "PREVIOUS_SNAPSHOT_SENTINEL",
    "ORPHAN_PAYLOAD_SENTINEL",
    "ORPHAN_SNAPSHOT_SENTINEL"
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
  assert.equal(report.migrationPreview.automaticActionAllowed, false);
  assert.equal(report.safetyReceipt.actionsApplied, 0);
}

async function assertV2ConversationPayloadContentAddressing(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-payload-v2-");
  const sessionId = "conversation-payload-v2";
  const commitId = "commit-payload-v2";
  const previousCommitId = "commit-payload-v2-previous";
  const contextId = "context-payload-v2";
  const generation = 3;
  const messages = [message("payload-v2-message", "assistant")];
  const snapshots = [committedConversationSnapshot({
    sessionId,
    contextId,
    generation,
    messageCount: messages.length
  })];
  const payloadKey = createConversationPayloadKeyV2(
    commitId,
    messages,
    snapshots
  );
  const previousPayloadKey = createConversationPayloadKeyV2(
    previousCommitId,
    [],
    []
  );
  await writeDataJson(fixture, [sessionId]);
  await writeCommittedConversation(fixture, {
    sessionId,
    commitId,
    payloadVersion: 2,
    payloadKey,
    previousPayloadKey,
    previousPayloadCommitId: previousCommitId,
    messages,
    contextId,
    generation
  });
  await writeConversationIndex(fixture, [conversationSummary(sessionId, 1)]);
  const sessionPath = path.join(fixture.conversationsPath, "sessions", sessionId);
  await writeJsonl(
    path.join(
      sessionPath,
      "context-payloads",
      previousPayloadKey,
      "messages.jsonl"
    ),
    []
  );
  await writeJsonl(
    path.join(
      sessionPath,
      "context-payloads",
      previousPayloadKey,
      "snapshots.jsonl"
    ),
    []
  );

  const valid = await scanAndBuild(fixture, { nativeScope: "none" });
  assert.equal(
    valid.findings.some((finding) =>
      finding.code === "conversation-payload-pointer-invalid"),
    false,
    "a valid V2 content-addressed payload must not be judged by the legacy commit-only key"
  );
  const metadataPath = path.join(sessionPath, "metadata.json");
  await rewriteWithStableStats(metadataPath, (source) => {
    const metadata = JSON.parse(source) as Record<string, unknown>;
    metadata.previousPayloadCommitId = "commit-payload-v2-replaced";
    return `${JSON.stringify(metadata, null, 2)}\n`;
  });
  const changedPreviousAuthority = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  assert.equal(
    changedPreviousAuthority.findings.some((finding) =>
      finding.code === "conversation-payload-pointer-invalid"),
    false
  );
  assert.notEqual(
    changedPreviousAuthority.snapshotFingerprint,
    valid.snapshotFingerprint,
    "same-stat previous payload authority changes must affect the inventory fingerprint"
  );

  await writeJsonl(
    path.join(
      sessionPath,
      "context-payloads",
      payloadKey,
      "messages.jsonl"
    ),
    [{ ...messages[0], text: "tampered after the marker" }]
  );
  const tampered = await scanAndBuild(fixture, { nativeScope: "none" });
  assertBlockingFinding(tampered, "conversation-payload-pointer-invalid");

  const pairingFixture = await createFixture(
    "echoink-storage-inventory-payload-v2-pairing-"
  );
  const pairingSessionId = "conversation-payload-v2-pairing";
  const pairingCommitId = "commit-payload-v2-pairing";
  const pairingMessages: Array<Record<string, unknown>> = [];
  const pairingSnapshots = [committedConversationSnapshot({
    sessionId: pairingSessionId,
    generation: 1,
    messageCount: 0
  })];
  const pairingPayloadKey = createConversationPayloadKeyV2(
    pairingCommitId,
    pairingMessages,
    pairingSnapshots
  );
  await writeDataJson(pairingFixture, [pairingSessionId]);
  await writeCommittedConversation(pairingFixture, {
    sessionId: pairingSessionId,
    commitId: pairingCommitId,
    payloadVersion: 2,
    payloadKey: pairingPayloadKey,
    previousPayloadKey: createConversationPayloadKeyV2(
      "commit-unpaired-previous",
      [],
      []
    ),
    messages: pairingMessages
  });
  await writeConversationIndex(pairingFixture, [
    conversationSummary(pairingSessionId, 0)
  ]);
  const pairingReads: string[] = [];
  const invalidPairing = await scanAndBuild(pairingFixture, {
    fs: readOnlyFs({
      onReadFile: (filePath) => {
        pairingReads.push(filePath);
        if (filePath.includes(`${path.sep}context-payloads${path.sep}`)) {
          throw new Error("an unpaired V2 previous pointer must fail before body reads");
        }
      }
    }),
    nativeScope: "none"
  });
  assertBlockingFinding(invalidPairing, "conversation-payload-pointer-invalid");
  assert.equal(
    pairingReads.some((filePath) =>
      filePath.includes(`${path.sep}context-payloads${path.sep}`)),
    false
  );
}

async function assertCommittedConversationPayloadPointersFailClosed(): Promise<void> {
  const missingFixture = await createFixture("echoink-storage-inventory-active-missing-");
  const missingSessionId = "conversation-active-missing";
  const missingCommitId = "commit-active-missing";
  await writeDataJson(missingFixture, [missingSessionId]);
  await writeCommittedConversation(missingFixture, {
    sessionId: missingSessionId,
    commitId: missingCommitId,
    payloadKey: conversationPayloadKey(missingCommitId),
    messages: [],
    omitPayloadFiles: true
  });
  await writeConversationIndex(missingFixture, [
    conversationSummary(missingSessionId, 0)
  ]);
  const missing = await scanAndBuild(missingFixture, { nativeScope: "none" });
  assertBlockingFinding(missing, "conversation-active-payload-missing");

  const invalidFixture = await createFixture("echoink-storage-inventory-pointer-invalid-");
  const invalidSessionId = "conversation-pointer-invalid";
  await writeDataJson(invalidFixture, [invalidSessionId]);
  await writeCommittedConversation(invalidFixture, {
    sessionId: invalidSessionId,
    commitId: "commit-pointer-a",
    payloadKey: conversationPayloadKey("commit-pointer-b"),
    messages: [message("must-not-be-authoritative", "assistant")]
  });
  await writeConversationIndex(invalidFixture, [
    conversationSummary(invalidSessionId, 1)
  ]);
  const invalidSessionPath = path.join(
    invalidFixture.conversationsPath,
    "sessions",
    invalidSessionId
  );
  const invalidReads: string[] = [];
  const invalid = await scanAndBuild(invalidFixture, {
    fs: readOnlyFs({
      onReadFile: (filePath) => {
        invalidReads.push(filePath);
        if (filePath.includes(`${path.sep}context-payloads${path.sep}`)) {
          throw new Error("invalid pointer must fail before payload body read");
        }
      }
    }),
    nativeScope: "none"
  });
  assertBlockingFinding(invalid, "conversation-payload-pointer-invalid");
  assert.equal(
    invalidReads.some((filePath) =>
      isWithin(filePath, path.join(invalidSessionPath, "context-payloads"))),
    false
  );

  const symlinkFixture = await createFixture("echoink-storage-inventory-active-symlink-");
  const symlinkSessionId = "conversation-active-symlink";
  const symlinkCommitId = "commit-active-symlink";
  const symlinkPayloadKey = conversationPayloadKey(symlinkCommitId);
  await writeDataJson(symlinkFixture, [symlinkSessionId]);
  await writeCommittedConversation(symlinkFixture, {
    sessionId: symlinkSessionId,
    commitId: symlinkCommitId,
    payloadKey: symlinkPayloadKey,
    messages: [],
    omitPayloadFiles: true
  });
  await writeConversationIndex(symlinkFixture, [
    conversationSummary(symlinkSessionId, 0)
  ]);
  const outsidePayload = path.join(symlinkFixture.vaultPath, "outside-active-payload");
  await mkdir(outsidePayload, { recursive: true });
  await writeJsonl(path.join(outsidePayload, "messages.jsonl"), [
    message("outside-message", "assistant")
  ]);
  await writeJsonl(path.join(outsidePayload, "snapshots.jsonl"), []);
  await symlink(
    outsidePayload,
    path.join(
      symlinkFixture.conversationsPath,
      "sessions",
      symlinkSessionId,
      "context-payloads",
      symlinkPayloadKey
    )
  );
  const symlinkReport = await scanAndBuild(symlinkFixture, {
    nativeScope: "none"
  });
  assertBlockingFinding(symlinkReport, "symlink-blocked");
  assertBlockingFinding(symlinkReport, "conversation-active-payload-missing");
}

async function assertHistoryIndexAndDuplicateMessageDrift(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-history-");
  await writeDataJson(fixture, ["knowledge-session"]);
  await writeConversation(fixture, "knowledge-session", [
    message("duplicate-message", "user")
  ], "knowledge-base");
  await writeConversationIndex(fixture, [
    conversationSummary("knowledge-session", 1, "knowledge-base")
  ]);
  await writeHistoryDay(fixture, "knowledge-session", "2026-07-17", [
    message("duplicate-message", "assistant")
  ]);
  await writeHistoryDay(fixture, "knowledge-session", "2026-07-18", [
    message("duplicate-message", "user")
  ]);
  await writeHistoryIndex(fixture, [
    historySessionSummary("knowledge-session", [
      historyDaySummary("2026-07-17", 1),
      historyDaySummary("2026-07-16", 1)
    ])
  ]);

  const report = await scanAndBuild(fixture);

  assertFinding(report, "history-day-index-drift");
  assertFinding(report, "history-day-unindexed");
  assertFinding(report, "duplicate-message-id");
  assert.ok(report.migrationPreview.candidateRecordCount > 0);
}

async function assertHistoryV2ReferencesLinkAndNeverOwnRaw():
Promise<void> {
  const fixture = await createFixture(
    "echoink-storage-inventory-history-v2-"
  );
  const linked = {
    ...message("history-v2-linked", "assistant"),
    rawRef: "raw/history-v2-linked.txt"
  };
  const drifted = message("history-v2-drifted", "user");
  await writeDataJson(fixture, ["knowledge-session"]);
  await writeConversation(
    fixture,
    "knowledge-session",
    [linked, drifted],
    "knowledge-base"
  );
  await writeConversationIndex(fixture, [
    conversationSummary("knowledge-session", 2, "knowledge-base")
  ]);
  await writeFile(
    path.join(fixture.rawPath, "history-v2-linked.txt"),
    `${SECRET}:history-v2`,
    "utf8"
  );
  await writeHistoryV2Projection(
    fixture,
    "knowledge-session",
    [linked, drifted],
    [
      historyV2Reference("knowledge-session", linked),
      {
        ...historyV2Reference("knowledge-session", drifted),
        messageRevision: stableFixtureRevision({
          ...drifted,
          text: "same ID, different canonical body"
        })
      },
      historyV2Reference(
        "knowledge-session",
        message("history-v2-missing", "assistant")
      )
    ]
  );

  const report = await scanAndBuild(fixture);
  const historySource = report.sources.find(
    (source) => source.sourceId === "history"
  );
  assert.equal(historySource?.schemaVersion, "2");
  assert.equal(
    historySource?.metrics?.find(
      (metric) => metric.name === "raw-reference-count"
    )?.value,
    0,
    "History V2 must never become a Raw owner"
  );
  const historyRelations = report.relations.filter(
    (relation) => relation.kind === "history-message-projection"
  );
  assert.deepEqual(
    [...new Set(historyRelations.map((relation) => relation.status))].sort(),
    ["ambiguous", "linked", "missing"],
    "every V2 ref must produce a linked, missing, or ambiguous relation"
  );
  assertBlockingFinding(
    report,
    "history-reference-revision-mismatch"
  );
  assertBlockingFinding(
    report,
    "history-reference-source-missing"
  );
  assert.equal(
    report.relations.some(
      (relation) =>
        relation.from.sourceId === "history"
        && relation.kind.includes("raw")
    ),
    false
  );
}

async function assertHistoryV2RejectsBodyFields(): Promise<void> {
  const fixture = await createFixture(
    "echoink-storage-inventory-history-v2-body-"
  );
  const canonical = message("history-v2-body", "assistant");
  await writeDataJson(fixture, ["knowledge-session"]);
  await writeConversation(
    fixture,
    "knowledge-session",
    [canonical],
    "knowledge-base"
  );
  await writeConversationIndex(fixture, [
    conversationSummary("knowledge-session", 1, "knowledge-base")
  ]);
  await writeHistoryV2Projection(
    fixture,
    "knowledge-session",
    [canonical],
    [{
      ...historyV2Reference("knowledge-session", canonical),
      text: "History must reject copied body text",
      rawRef: "raw/forbidden.txt"
    }]
  );

  const report = await scanAndBuild(fixture);
  assertBlockingFinding(report, "history-reference-invalid");
  assert.equal(sourceStatus(report, "history"), "partial");
}

async function assertRawReferenceGraphNeverReadsRawBodies(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-raw-");
  await writeDataJson(fixture, ["conversation-a"]);
  await writeConversation(fixture, "conversation-a", [
    { ...message("raw-valid", "assistant"), rawRef: "raw/raw-valid.txt" },
    { ...message("raw-missing", "assistant"), rawRef: "raw/raw-missing.txt" }
  ]);
  await writeConversationIndex(fixture, [conversationSummary("conversation-a", 2)]);
  await writeFile(path.join(fixture.rawPath, "raw-valid.txt"), `${SECRET}:valid`, "utf8");
  await writeFile(path.join(fixture.rawPath, "raw-unreferenced.txt"), `${SECRET}:unreferenced`, "utf8");
  const reads: string[] = [];
  const recordingFs = readOnlyFs({
    onReadFile: (filePath) => {
      reads.push(filePath);
      if (isWithin(filePath, fixture.rawPath)) {
        throw new Error(`Raw body must not be read: ${filePath}`);
      }
    }
  });

  const report = await scanAndBuild(fixture, { fs: recordingFs });

  assertFinding(report, "raw-reference-missing");
  assertFinding(report, "raw-file-unreferenced");
  assert.equal(reads.some((filePath) => isWithin(filePath, fixture.rawPath)), false);
  assert.equal(report.safetyReceipt.rawBodiesRead, false);
  assert.equal(JSON.stringify(report).includes("raw-unreferenced.txt"), false);
  assert.ok(report.migrationPreview.wouldRetainRecordCount > 0);
  assert.doesNotMatch(serializeStorageInventoryReport(report), new RegExp(SECRET));
}

async function assertRunLedgerIntegrityFindings(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-runs-");
  await writeDataJson(fixture, []);
  await writeRun(fixture, "filename-run", [
    runEvent("other-run", 1, "run.started"),
    runEvent("other-run", 3, "agent.message.completed"),
    runEvent("second-run", 4, "run.completed"),
    {
      ...runEvent("other-run", 5, "agent.message.completed"),
      text: SECRET,
      data: { prompt: SECRET, output: SECRET }
    }
  ]);
  await writeRun(fixture, "terminal-without-commit", [
    runEvent("terminal-without-commit", 1, "run.started"),
    runEvent("terminal-without-commit", 2, "run.completed")
  ]);
  await writeRun(fixture, "missing-terminal", [
    runEvent("missing-terminal", 1, "run.started"),
    runEvent("missing-terminal", 2, "agent.message.completed")
  ]);
  const committedNativeRecord = nativeRecord(
    "native-with-missing-run-commit",
    "codex-cli",
    "thread-with-missing-run-commit",
    { runId: "terminal-without-commit" }
  );
  await writeNativeIndex(fixture, [committedNativeRecord]);
  await writeNativeEvents(fixture, [
    { type: "upsert", record: committedNativeRecord, createdAt: 1 }
  ]);

  const report = await scanAndBuild(fixture);

  assertFinding(report, "run-sequence-drift");
  assertFinding(report, "run-terminal-missing");
  assertFinding(report, "run-local-commit-missing");
  assert.doesNotMatch(serializeStorageInventoryReport(report), new RegExp(SECRET));
}

async function assertRunEventWithoutRunIdBlocksMigration(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-run-event-shape-");
  await writeDataJson(fixture, []);
  await writeRun(fixture, "invalid-event", [
    runEvent("invalid-event", 1, "run.started"),
    {
      sequence: 2,
      source: "kernel",
      type: "run.completed",
      backendId: "codex-cli",
      createdAt: 2
    },
    "not-an-object"
  ]);

  const report = await scanAndBuild(fixture);

  assertBlockingFinding(report, "run-event-metadata-invalid");
  assert.equal(sourceStatus(report, "harness-runs"), "partial");
}

async function assertNativeReplayDriftAndQuarantineCandidate(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-native-");
  await writeDataJson(fixture, []);
  const indexed = nativeRecord("native-indexed", "codex-cli", "codex-thread-indexed", {
    cleanup: "failed",
    attempts: 8,
    lastError: `${SECRET}: archive failed`
  });
  const replayed = nativeRecord("native-replayed", "opencode", "opencode-session-replayed");
  const divergentIndexed = nativeRecord(
    "native-divergent",
    "codex-cli",
    "codex-thread-before"
  );
  const divergentReplayed = nativeRecord(
    "native-divergent",
    "codex-cli",
    "codex-thread-after"
  );
  const duplicate = nativeRecord(
    "native-duplicate",
    "hermes",
    "hermes-session-duplicate"
  );
  await writeNativeIndex(fixture, [
    indexed,
    divergentIndexed,
    duplicate,
    { ...duplicate, workflow: "knowledge.duplicate" }
  ]);
  await writeNativeEvents(fixture, [
    { type: "upsert", record: replayed, createdAt: 10 },
    { type: "upsert", record: divergentReplayed, createdAt: 11 }
  ]);

  const report = await scanAndBuild(fixture);

  assertFindingCount(report, "native-audit-projection-drift", 3);
  assert.equal(
    report.findings.some((finding) =>
      finding.code === "native-audit-projection-drift"
      && finding.category === "ambiguous"),
    true,
    "same-ID structural disagreement must remain visible as non-authoritative audit drift"
  );
  assert.equal(
    report.findings.some((finding) =>
      finding.code === "native-audit-projection-drift"
      && finding.blocksMigration),
    false,
    "audit projection drift must not overturn a valid authority index"
  );
  assertFinding(report, "native-index-duplicate-id");
  assertFinding(report, "quarantined-candidate");
  assert.ok(
    (report.sources.find(({ sourceId }) => sourceId === "native-store")
      ?.corruptCount ?? 0) > 0
  );
  assert.equal(report.migrationPreview.status, "blocked");
  assert.equal(JSON.stringify(report).includes("native-indexed"), false);
  assert.ok(report.migrationPreview.candidateRecordCount > 0);
  assert.doesNotMatch(serializeStorageInventoryReport(report), new RegExp(SECRET));
}

async function assertNativeAuditProjectionNeverBecomesAuthority(): Promise<void> {
  const fixture = await createFixture(
    "echoink-storage-inventory-native-audit-only-"
  );
  const record = nativeRecord(
    "native-audit-authority",
    "codex-cli",
    "thread-audit-authority"
  );
  await writeNativeIndex(fixture, [record], 2);
  await writeFile(
    path.join(fixture.nativePath, "native-executions.jsonl"),
    `${JSON.stringify({ type: "upsert", record, createdAt: 1 })}\n`
      + `{"type":"upsert","record":"${SECRET}"\n`,
    "utf8"
  );

  const corruptAudit = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  const corruptAuditSource = corruptAudit.sources.find(
    ({ sourceId }) => sourceId === "native-store"
  );
  assert.equal(corruptAuditSource?.recordCount, 1);
  assert.equal(
    corruptAuditSource?.corruptCount,
    0,
    "invalid audit rows must not mark the authoritative index corrupt"
  );
  assert.equal(
    corruptAudit.findings.some((finding) =>
      finding.code === "native-audit-projection-drift"
      && finding.blocksMigration),
    false
  );
  assert.doesNotMatch(
    serializeStorageInventoryReport(corruptAudit),
    new RegExp(SECRET)
  );

  const eventsPath = path.join(
    fixture.nativePath,
    "native-executions.jsonl"
  );
  await rm(eventsPath);
  const missingAudit = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  const missingAuditSource = missingAudit.sources.find(
    ({ sourceId }) => sourceId === "native-store"
  );
  assert.equal(missingAuditSource?.recordCount, 1);
  assert.equal(missingAuditSource?.corruptCount, 0);
  assert.equal(
    missingAudit.findings.some((finding) =>
      finding.code === "native-audit-projection-drift"
      && finding.blocksMigration),
    false,
    "missing audit history must not overturn a valid authority index"
  );
}

async function assertNativeSchemaAndLifecycleCompatibility(): Promise<void> {
  const currentFixture = await createFixture("echoink-storage-inventory-native-v2-");
  const retirement = {
    targetConversationId: "conversation-retirement",
    targetGeneration: 2,
    targetCommitId: "commit-retirement",
    targetContextId: "context-retirement",
    targetWorkspaceFingerprint: `sha256:${"a".repeat(64)}`,
    reason: "workspace-switch"
  };
  const records = [
    nativeRecord("native-awaiting", "codex-cli", "thread-awaiting", {
      localCommit: "pending",
      cleanup: "awaiting-local-commit",
      retirement
    }),
    nativeRecord("native-pending-exhausted", "codex-cli", "thread-pending", {
      cleanup: "pending",
      attempts: 6
    }),
    nativeRecord("native-disposing", "opencode", "session-disposing", {
      cleanup: "disposing",
      cleanupStartedAt: 11
    }),
    nativeRecord("native-failed-exhausted", "hermes", "run-failed", {
      native: {
        ...nativeRecord("transport-source", "hermes", "run-failed").native,
        transport: "acp-stdio"
      },
      cleanup: "failed",
      attempts: 7
    }),
    nativeRecord("native-aborted", "opencode", "session-aborted", {
      localCommit: "failed",
      cleanup: "aborted",
      retirement: { ...retirement, targetCommitId: "commit-aborted" }
    }),
    nativeRecord("native-quarantined", "hermes", "run-quarantined", {
      cleanup: "quarantined",
      quarantinedAt: 12,
      retirement: { ...retirement, targetCommitId: "commit-quarantined" }
    })
  ];
  await writeNativeIndex(currentFixture, records, 2);
  await writeNativeEvents(currentFixture, records.map((record, index) => ({
    type: "upsert",
    record,
    createdAt: index + 1
  })));

  const current = await scanAndBuild(currentFixture, { nativeScope: "none" });
  const currentSource = current.sources.find(({ sourceId }) => sourceId === "native-store");
  assert.equal(currentSource?.schemaVersion, "2");
  assert.equal(currentSource?.corruptCount, 0);
  assert.equal(currentSource?.futureSchemaCount, 0);
  assert.equal(currentSource?.recordCount, records.length);
  assert.equal(
    current.findings.some((finding) =>
      finding.code === "native-audit-projection-drift"),
    false,
    "a safe transport must survive authoritative index/audit projection comparison"
  );
  assert.equal(
    current.findings.filter((finding) => finding.code === "cleanup-pending").length,
    4,
    "awaiting, pending, disposing and failed records are cleanup/recovery backlog"
  );
  assert.equal(
    current.findings.filter((finding) => finding.code === "quarantined-candidate").length,
    2,
    "pending and failed retry-limit records are candidates, not actual quarantine"
  );
  const quarantined = current.findings.filter(
    (finding) => finding.code === "cleanup-quarantined"
  );
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0]?.category, "quarantined");
  assert.equal(quarantined[0]?.blocksMigration, false);

  const legacyFixture = await createFixture("echoink-storage-inventory-native-v1-");
  const legacyRecord = nativeRecord(
    "native-v1-record",
    "codex-cli",
    "thread-v1-record"
  );
  await writeNativeIndex(legacyFixture, [legacyRecord], 1);
  await writeNativeEvents(legacyFixture, [{
    type: "upsert",
    record: legacyRecord,
    createdAt: 1
  }]);
  const legacy = await scanAndBuild(legacyFixture, { nativeScope: "none" });
  const legacySource = legacy.sources.find(({ sourceId }) => sourceId === "native-store");
  assertBlockingFinding(legacy, "native-schema-migration-required");
  assert.equal(legacySource?.schemaVersion, "1");
  assert.equal(legacySource?.corruptCount, 0);
  assert.equal(legacySource?.futureSchemaCount, 0);
  assert.equal(legacySource?.recordCount, 1);

  const partialSourceFixture = await createFixture(
    "echoink-storage-inventory-native-partial-source-"
  );
  const partialSourceRecord = nativeRecord(
    "native-partial-source",
    "codex-cli",
    "thread-partial-source",
    {
      localCommit: "pending",
      cleanup: "awaiting-local-commit",
      retirement: {
        ...retirement,
        sourceGeneration: 1
      }
    }
  );
  await writeNativeIndex(partialSourceFixture, [partialSourceRecord], 2);
  await writeNativeEvents(partialSourceFixture, [{
    type: "upsert",
    record: partialSourceRecord,
    createdAt: 1
  }]);
  const partialSource = await scanAndBuild(partialSourceFixture, {
    nativeScope: "none"
  });
  assertBlockingFinding(partialSource, "native-record-invalid");
  const partialSourceStatus = partialSource.sources.find(
    ({ sourceId }) => sourceId === "native-store"
  );
  assert.equal(partialSourceStatus?.recordCount, 0);
  assert.ok((partialSourceStatus?.corruptCount ?? 0) > 0);

  const unsafeTransportFixture = await createFixture(
    "echoink-storage-inventory-native-unsafe-transport-"
  );
  const unsafeTransportRecords = [
    nativeRecord("native-sensitive-transport", "hermes", "session-sensitive", {
      native: {
        ...nativeRecord("sensitive-source", "hermes", "session-sensitive").native,
        transport: "acp-stdio?token=TOP_SECRET"
      }
    }),
    nativeRecord("native-overlong-transport", "hermes", "session-overlong", {
      native: {
        ...nativeRecord("overlong-source", "hermes", "session-overlong").native,
        transport: `a-${"x".repeat(128)}`
      }
    })
  ];
  await writeNativeIndex(unsafeTransportFixture, unsafeTransportRecords, 2);
  await writeNativeEvents(
    unsafeTransportFixture,
    unsafeTransportRecords.map((record, index) => ({
      type: "upsert",
      record,
      createdAt: index + 1
    }))
  );
  const unsafeTransportReport = await scanAndBuild(
    unsafeTransportFixture,
    { nativeScope: "none" }
  );
  const unsafeTransportSource = unsafeTransportReport.sources.find(
    ({ sourceId }) => sourceId === "native-store"
  );
  assert.equal(unsafeTransportSource?.recordCount, 0);
  assert.equal(unsafeTransportSource?.corruptCount, 2);
  assertBlockingFinding(unsafeTransportReport, "native-record-invalid");
  assert.doesNotMatch(
    serializeStorageInventoryReport(unsafeTransportReport),
    /TOP_SECRET/
  );

  const futureFixture = await createFixture("echoink-storage-inventory-native-v3-");
  await writeNativeIndex(futureFixture, [], 3);
  const future = await scanAndBuild(futureFixture, { nativeScope: "none" });
  const futureSource = future.sources.find(({ sourceId }) => sourceId === "native-store");
  assertBlockingFinding(future, "future-schema");
  assert.equal(futureSource?.schemaVersion, "3");
  assert.equal(futureSource?.futureSchemaCount, 1);
}

async function assertNativeRetirementUsesConversationCommitAuthority(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-native-retirement-");
  const sessionId = "conversation-retirement";
  const commitId = "commit-retirement";
  await writeDataJson(fixture, [sessionId]);
  await writeCommittedConversation(fixture, {
    sessionId,
    commitId,
    payloadKey: conversationPayloadKey(commitId),
    messages: [],
    contextId: "context-retirement",
    generation: 2,
    workspaceFingerprint: `sha256:${"b".repeat(64)}`
  });
  await writeConversationIndex(fixture, [conversationSummary(sessionId, 0)]);
  const record = nativeRecord(
    "native-retirement-record",
    "opencode",
    "session-retirement-record",
    {
      runId: "synthetic-retirement-run-without-ledger",
      sessionId,
      localCommit: "pending",
      cleanup: "awaiting-local-commit",
      retirement: {
        targetConversationId: sessionId,
        sourceGeneration: 1,
        sourceCommitId: "commit-source-aa",
        sourceContextId: "context-source-aa",
        sourceWorkspaceFingerprint: `sha256:${"a".repeat(64)}`,
        targetGeneration: 2,
        targetCommitId: commitId,
        targetContextId: "context-retirement",
        targetWorkspaceFingerprint: `sha256:${"b".repeat(64)}`,
        reason: "reason-a"
      }
    }
  );
  await writeNativeIndex(fixture, [record], 2);
  await writeNativeEvents(fixture, [{ type: "upsert", record, createdAt: 1 }]);

  const before = await scanAndBuild(fixture, { nativeScope: "none" });
  assert.equal(
    before.findings.some((finding) => finding.code === "native-run-missing"),
    false,
    "synthetic retirement records must not require an ordinary Harness Run"
  );
  assert.equal(
    before.relations.some((relation) =>
      relation.kind === "native-retirement-commit"
      && relation.status === "linked"),
    true
  );

  const indexPath = path.join(
    fixture.nativePath,
    "native-executions-index.json"
  );
  const eventsPath = path.join(
    fixture.nativePath,
    "native-executions.jsonl"
  );
  const changed = structuredClone(record);
  changed.retirement!.reason = "reason-b";
  await rewritePairWithStableStats([
    {
      filePath: indexPath,
      write: () => writeNativeIndex(fixture, [changed], 2)
    },
    {
      filePath: eventsPath,
      write: () => writeNativeEvents(fixture, [
        { type: "upsert", record: changed, createdAt: 1 }
      ])
    }
  ]);
  const after = await scanAndBuild(fixture, { nativeScope: "none" });
  assert.notEqual(
    after.snapshotFingerprint,
    before.snapshotFingerprint,
    "retirement-only metadata changes must affect the inventory fingerprint"
  );

  const sourceChanged = structuredClone(changed);
  sourceChanged.retirement!.sourceCommitId = "commit-source-bb";
  await rewritePairWithStableStats([
    {
      filePath: indexPath,
      write: () => writeNativeIndex(fixture, [sourceChanged], 2)
    },
    {
      filePath: eventsPath,
      write: () => writeNativeEvents(fixture, [
        { type: "upsert", record: sourceChanged, createdAt: 1 }
      ])
    }
  ]);
  const sourceAfter = await scanAndBuild(fixture, { nativeScope: "none" });
  assert.notEqual(
    sourceAfter.snapshotFingerprint,
    after.snapshotFingerprint,
    "source authority identity changes must affect the inventory fingerprint"
  );

  const mismatched = structuredClone(sourceChanged);
  mismatched.retirement!.targetGeneration = 3;
  await writeNativeIndex(fixture, [mismatched], 2);
  await writeNativeEvents(fixture, [{
    type: "upsert",
    record: mismatched,
    createdAt: 1
  }]);
  const mismatch = await scanAndBuild(fixture, { nativeScope: "none" });
  assertBlockingFinding(mismatch, "native-retirement-commit-mismatch");
  assert.equal(
    mismatch.relations.some((relation) =>
      relation.kind === "native-retirement-commit"
      && relation.status === "ambiguous"),
    true
  );
}

async function assertDeletedNativeRetirementUsesCommittedTombstoneAuthority():
Promise<void> {
  const fixture = await createFixture(
    "echoink-storage-inventory-deleted-retirement-"
  );
  const sessionId = "conversation-deleted-retirement";
  const mutationId = "mutation-deleted-retirement";
  const sourceGeneration = 2;
  const sourceCommitId = "commit-deleted-retirement-source";
  const sourceContentRevision = `sha256:${"1".repeat(64)}`;
  const tombstone = createConversationDeletionTombstone({
    conversationId: sessionId,
    mutationId,
    tombstoneId: "tombstone-deleted-retirement",
    sourceGeneration,
    sourceCommitId,
    sourceContentRevision,
    deletedAt: 10
  });
  await writeJson(
    path.join(
      fixture.conversationsPath,
      "deletions",
      `${sessionId}.json`
    ),
    tombstone
  );

  let journal = await createRecordMutationJournal({
    storageRootPath: fixture.pluginDataPath,
    mutationId,
    intent: {
      operation: "delete-conversation",
      conversationId: sessionId,
      expectedConversationGeneration: sourceGeneration,
      expectedConversationCommitId: sourceCommitId,
      expectedConversationContentRevision: sourceContentRevision,
      targetConversation: {
        status: "deleted",
        tombstoneId: tombstone.tombstoneId,
        digest: tombstone.digest
      },
      participants: [{
        id: "conversation",
        recordKind: "conversation",
        action: "stage"
      }],
      rootBindings: fixtureRecordMutationRootBindings(),
      trashPolicy: "required"
    },
    createdAt: 10
  });
  journal = await stageRecordMutationJournal(journal.handle, {
    expectedRevision: journal.record.revision,
    expectedDigest: journal.record.digest,
    step: {
      direction: "forward",
      ordinal: 1,
      participantId: "conversation",
      action: "trash-staged",
      evidenceDigest: journal.record.intentDigest
    },
    updatedAt: 11
  });
  journal = await stageRecordMutationJournal(journal.handle, {
    expectedRevision: journal.record.revision,
    expectedDigest: journal.record.digest,
    step: {
      direction: "forward",
      ordinal: 2,
      participantId: "conversation",
      action: "source-retired",
      evidenceDigest: journal.record.intentDigest
    },
    updatedAt: 12
  });
  await commitRecordMutationJournal(journal.handle, {
    expectedRevision: journal.record.revision,
    expectedDigest: journal.record.digest,
    committedAt: 13,
    message: "committed fixture deletion"
  });

  const record = nativeRecord(
    "native-deleted-retirement",
    "opencode",
    "session-deleted-retirement",
    {
      runId: `conversation-deletion:${mutationId}`,
      sessionId,
      surface: "chat",
      workflow: "session.context-rotation.delete-conversation",
      policy: {
        historyAuthority: "echoink",
        mode: "leased-conversation",
        preferredDisposition: ["delete"],
        retainWhenLocalCommitFails: true,
        cleanupRequiredForTaskSuccess: false
      },
      localCommit: "committed",
      cleanup: "pending",
      requestedDisposition: "delete",
      nextAttemptAt: 13,
      disposedAt: 0,
      retirement: {
        recordMutationId: mutationId,
        targetConversationId: sessionId,
        sourceGeneration,
        sourceCommitId,
        sourceContextId: "context-deleted-retirement",
        sourceWorkspaceFingerprint: `sha256:${"2".repeat(64)}`,
        targetStatus: "deleted",
        targetTombstoneId: tombstone.tombstoneId,
        targetTombstoneDigest: tombstone.digest,
        reason: "delete-conversation"
      }
    }
  );
  await writeNativeIndex(fixture, [record], 2);
  await writeNativeEvents(fixture, [{
    type: "upsert",
    record,
    createdAt: 13
  }]);

  const report = await scanAndBuild(fixture, { nativeScope: "none" });
  assert.equal(
    report.findings.some(
      (finding) =>
        finding.code === "native-retirement-commit-mismatch"
    ),
    false
  );
  assert.equal(sourceStatus(report, "record-mutations"), "scanned");
  assert.equal(
    report.relations.some((relation) =>
      relation.kind === "native-retirement-commit"
      && relation.to.sourceId === "record-mutations"
      && relation.status === "linked"),
    true
  );
  assert.equal(
    report.relations.some((relation) =>
      relation.kind === "native-conversation-ownership"
      && relation.to.entityType === "tombstone"
      && relation.status === "linked"),
    true
  );

  const mismatched = structuredClone(record);
  if (mismatched.retirement?.targetStatus === "deleted") {
    mismatched.retirement.targetTombstoneDigest =
      `sha256:${"e".repeat(64)}`;
  }
  await writeNativeIndex(fixture, [mismatched], 2);
  await writeNativeEvents(fixture, [{
    type: "upsert",
    record: mismatched,
    createdAt: 14
  }]);
  const mismatch = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  assertBlockingFinding(
    mismatch,
    "native-retirement-commit-mismatch"
  );
}

async function assertProviderUnknownIsNotMissingOrOrphaned(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-provider-");
  await writeDataJson(fixture, []);
  const codex = nativeRecord("native-codex", "codex-cli", "codex-linked-missing");
  const openCode = nativeRecord("native-opencode", "opencode", "opencode-linked-present");
  const hermes = nativeRecord("native-hermes", "hermes", "hermes-linked-unknown");
  await writeNativeIndex(fixture, [codex, openCode, hermes]);
  await writeNativeEvents(fixture, [
    { type: "upsert", record: codex, createdAt: 1 },
    { type: "upsert", record: openCode, createdAt: 2 },
    { type: "upsert", record: hermes, createdAt: 3 }
  ]);
  const nativeOptions = {
    nativeScope: "vault" as const,
    nativeProviderProbes: {
      codex: async () => ({
        status: "scanned",
        capabilities: { inspectExistence: "supported" },
        completeLinkedInspection: true,
        records: []
      }),
      opencode: async () => ({
        status: "scanned",
        capabilities: { inspectExistence: "supported" },
        completeLinkedInspection: true,
        records: [
          { id: "opencode-linked-present", kind: "session", cwd: fixture.vaultPath },
          { id: "opencode-unlinked-vault", kind: "session", cwd: fixture.vaultPath }
        ]
      }),
      hermes: async () => ({
        status: "unavailable",
        capabilities: { inspectExistence: "unsupported" },
        completeLinkedInspection: false,
        records: []
      })
    }
  };

  const report = await scanAndBuild(fixture, nativeOptions);
  const findings = report.findings;

  assertFinding(report, "native-linked-missing");
  assertFinding(report, "native-unlinked-candidate");
  assert.equal(
    findings.some((finding) => finding.sourceId === "provider-hermes" && finding.category === "ambiguous"),
    true,
    "unavailable Hermes probe must surface an explicit ambiguous provider finding"
  );
  assert.equal(
    findings.some((finding) =>
      finding.code === "native-linked-missing"
      && finding.sourceId === "provider-hermes"),
    false,
    "provider unknown must not be classified as missing"
  );
  assert.equal(
    JSON.stringify(report).toLowerCase().includes("orphan"),
    false,
    "unattributed provider records must not be classified as orphaned"
  );
  assert.equal(report.migrationPreview.automaticActionAllowed, false);
  assert.equal(report.migrationPreview.destructiveActionCount, 0);
}

async function assertIncompleteLinkedInspectionRemainsUnknown(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-provider-incomplete-");
  await writeDataJson(fixture, []);
  const hermes = nativeRecord(
    "native-hermes-incomplete",
    "hermes",
    "hermes-linked-incomplete"
  );
  await writeNativeIndex(fixture, [hermes]);
  await writeNativeEvents(fixture, [
    { type: "upsert", record: hermes, createdAt: 1 }
  ]);

  const report = await scanAndBuild(fixture, {
    nativeScope: "linked",
    nativeProviderProbes: {
      hermes: async () => ({
        status: "scanned",
        capabilities: { inspectExistence: "supported" },
        completeLinkedInspection: false,
        records: []
      })
    }
  });
  const provider = report.providers.find(({ providerId }) => providerId === "hermes");
  const relation = report.relations.find((candidate) =>
    candidate.kind === "native-provider-existence"
    && candidate.to.sourceId === "provider-hermes");

  assert.equal(provider?.inspectedCount, 0);
  assert.equal(provider?.missingCount, 0);
  assert.equal(relation?.status, "ambiguous");
  assert.equal(
    report.findings.some((finding) =>
      finding.sourceId === "provider-hermes"
      && finding.code === "native-linked-missing"),
    false,
    "an omitted record remains unknown without an explicit complete-inspection receipt"
  );
}

async function assertProviderKindMismatchRemainsAmbiguous(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-provider-kind-");
  await writeDataJson(fixture, []);
  const base = nativeRecord(
    "native-hermes-run",
    "hermes",
    "hermes-shared-id"
  );
  const hermesRun: NativeExecutionRecord = {
    ...base,
    native: {
      ...base.native,
      kind: "run"
    }
  };
  await writeNativeIndex(fixture, [hermesRun]);
  await writeNativeEvents(fixture, [
    { type: "upsert", record: hermesRun, createdAt: 1 }
  ]);

  const report = await scanAndBuild(fixture, {
    nativeScope: "linked",
    nativeProviderProbes: {
      hermes: async () => ({
        status: "scanned",
        capabilities: { inspectExistence: "supported" },
        completeLinkedInspection: true,
        records: [{
          id: "hermes-shared-id",
          kind: "session",
          exists: true
        }]
      })
    }
  });
  const provider = report.providers.find(({ providerId }) => providerId === "hermes");
  const relation = report.relations.find((candidate) =>
    candidate.kind === "native-provider-existence"
    && candidate.to.sourceId === "provider-hermes");

  assert.equal(provider?.status, "partial");
  assert.equal(provider?.existingCount, 0);
  assert.equal(provider?.missingCount, 0);
  assert.equal(relation?.status, "ambiguous");
  assertFinding(report, "provider-linked-kind-mismatch");
}

async function assertUnknownProviderStatusCodeIsNormalized(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-provider-code-");
  const privateStatusCode = "private-native-session-abc123";
  const report = await scanAndBuild(fixture, {
    nativeScope: "linked",
    nativeProviderProbes: {
      codex: async () => ({
        status: "partial",
        statusCode: privateStatusCode,
        capabilities: { inspectExistence: "unknown" },
        completeLinkedInspection: false,
        records: []
      }),
      opencode: async () => ({
        status: privateStatusCode as never,
        capabilities: { inspectExistence: "unknown" },
        completeLinkedInspection: false,
        records: []
      })
    }
  });
  const serialized = serializeStorageInventoryReport(report);
  const markdown = renderStorageInventoryMarkdown(report);
  const provider = report.providers.find(({ providerId }) => providerId === "codex");

  assert.equal(provider?.status, "partial");
  assert.equal(provider?.statusCode, "provider-probe-partial");
  assertFinding(report, "provider-probe-partial");
  const invalidStatusProvider = report.providers.find(
    ({ providerId }) => providerId === "opencode"
  );
  assert.equal(invalidStatusProvider?.status, "partial");
  assert.equal(invalidStatusProvider?.statusCode, "provider-probe-partial");
  assert.equal(report.migrationPreview.status, "partial");
  assert.equal(report.migrationPreview.blockingFindingIds.length, 0);
  assert.equal(`${serialized}\n${markdown}`.includes(privateStatusCode), false);
}

async function assertLocalProviderSqlScopeAndProjectionBoundaries(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-provider-sql-");
  const providerIds: readonly NativeProviderId[] = ["codex", "opencode", "hermes"];
  const databasePaths: Record<NativeProviderId, string> = {
    codex: path.join(fixture.vaultPath, "codex.db"),
    opencode: path.join(fixture.vaultPath, "opencode.db"),
    hermes: path.join(fixture.vaultPath, "hermes.db")
  };
  const calls: Array<{ executable: string; args: string[] }> = [];
  const executeSqlite: ReadOnlySqliteExecutor = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    return "[]";
  };
  const probes = createLocalNativeProviderProbes({
    sqliteExecutable: "/test/sqlite3",
    databasePaths,
    executeSqlite,
    maxVaultRecords: 17
  });

  for (const providerId of providerIds) {
    const result = await probes[providerId]({
      backendId: providerId,
      scope: "linked",
      linkedIds: [`linked-${providerId}`],
      vaultPath: fixture.vaultPath
    });
    assert.equal(result.completeLinkedInspection, false);
  }

  assert.equal(calls.length, providerIds.length);
  for (const [index, call] of calls.entries()) {
    const providerId = providerIds[index];
    assert.equal(call.executable, "/test/sqlite3");
    assert.deepEqual(call.args.slice(0, 3), [
      "-readonly",
      "-json",
      databasePaths[providerId]
    ]);
    const sql = sqliteQueryFromCall(call);
    assertMetadataOnlyProviderSelect(sql);
    assert.equal(
      sql.slice(sql.indexOf(" WHERE ")),
      ` WHERE id IN ('linked-${providerId}') ORDER BY id;`
    );
  }

  calls.length = 0;
  for (const providerId of providerIds) {
    await probes[providerId]({
      backendId: providerId,
      scope: "vault",
      linkedIds: [`linked-${providerId}`],
      vaultPath: fixture.vaultPath
    });
  }

  assert.equal(calls.length, providerIds.length * 2);
  for (const providerId of providerIds) {
    const providerCalls = calls.filter((call) => call.args[2] === databasePaths[providerId]);
    assert.equal(providerCalls.length, 2);
    const linkedCall = providerCalls.find((call) =>
      sqliteQueryFromCall(call).includes(" WHERE id IN "));
    const vaultCall = providerCalls.find((call) => call !== linkedCall);
    assert.ok(linkedCall);
    assert.ok(vaultCall);
    const linkedSql = sqliteQueryFromCall(linkedCall);
    const vaultSql = sqliteQueryFromCall(vaultCall);
    const cwdColumn = providerId === "opencode" ? "directory" : "cwd";

    assertMetadataOnlyProviderSelect(linkedSql);
    assertMetadataOnlyProviderSelect(vaultSql);
    assert.equal(
      linkedSql.slice(linkedSql.indexOf(" WHERE ")),
      ` WHERE id IN ('linked-${providerId}') ORDER BY id;`
    );
    assert.match(vaultSql, new RegExp(` WHERE \\(${cwdColumn} = `));
    assert.match(vaultSql, / ORDER BY id LIMIT 17;$/);
  }

  calls.length = 0;
  const invalidIdentifierResult = await probes.codex({
    backendId: "codex",
    scope: "linked",
    linkedIds: ["safe-id", "unsafe' OR 1=1 --"],
    vaultPath: fixture.vaultPath
  });
  const guardedSql = sqliteQueryFromCall(calls[0]);
  assert.equal(
    guardedSql.slice(guardedSql.indexOf(" WHERE ")),
    " WHERE id IN ('safe-id') ORDER BY id;"
  );
  assert.doesNotMatch(guardedSql, /OR 1=1|unsafe/);
  assert.equal(invalidIdentifierResult.status, "partial");
  assert.equal(invalidIdentifierResult.completeLinkedInspection, false);
}

async function assertMetadataOnlyReportsDoNotLeakBodies(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-redaction-");
  await writeDataJson(fixture, ["conversation-secret"], {
    title: SECRET,
    preview: SECRET,
    apiKey: SECRET
  });
  await writeConversation(fixture, "conversation-secret", [{
    ...message("secret-message", "assistant"),
    text: SECRET,
    title: SECRET,
    details: SECRET,
    processInput: SECRET,
    processOutput: SECRET,
    previewText: SECRET
  }]);
  await writeConversationIndex(fixture, [
    { ...conversationSummary("conversation-secret", 1), title: SECRET }
  ]);
  await writeRun(fixture, "secret-run", [{
    ...runEvent("secret-run", 1, "run.failed"),
    text: SECRET,
    data: {
      title: SECRET,
      prompt: SECRET,
      output: SECRET,
      first_user_message: SECRET
    }
  }]);
  const nativeSecret = nativeRecord("native-secret", "codex-cli", "thread-secret", {
    lastError: SECRET
  });
  await writeNativeIndex(fixture, [nativeSecret]);
  await writeNativeEvents(fixture, [{ type: "upsert", record: nativeSecret, createdAt: 1 }]);

  const input = await scanStorageInventory(scanOptions(fixture));
  const report = buildStorageInventoryReport(input);
  const serialized = serializeStorageInventoryReport(report);
  const markdown = renderStorageInventoryMarkdown(report);
  const visible = `${serialized}\n${markdown}`;

  assert.doesNotMatch(visible, new RegExp(SECRET));
  for (const forbiddenValue of [
    fixture.vaultPath,
    fixture.pluginDataPath,
    "conversation-secret",
    "secret-message",
    "secret-run",
    "native-secret",
    "thread-secret"
  ]) {
    assert.equal(
      visible.includes(forbiddenValue),
      false,
      `report must not expose source identifier ${forbiddenValue}`
    );
  }
  for (const forbidden of [
    "text",
    "content",
    "prompt",
    "output",
    "details",
    "processInput",
    "processOutput",
    "title",
    "preview",
    "first_user_message",
    "lastError"
  ]) {
    assert.equal(hasOwnKeyDeep(JSON.parse(serialized), forbidden), false, `${forbidden} must not appear in report JSON`);
  }
  assert.equal(report.contentPolicy.mode, "metadata-only");
  assert.equal(report.safetyReceipt.rawBodiesRead, false);

  const messagesPath = path.join(
    fixture.conversationsPath,
    "sessions",
    "conversation-secret",
    "messages.jsonl"
  );
  const messagesStat = await lstat(messagesPath);
  const messagesSource = await readFile(messagesPath, "utf8");
  assert.match(messagesSource, new RegExp(SECRET));
  await writeFile(messagesPath, messagesSource.replaceAll(SECRET, "ALT_SECRET_BODY"), "utf8");
  await utimes(messagesPath, messagesStat.atime, messagesStat.mtime);
  const bodyChanged = await scanAndBuild(fixture);
  assert.equal(
    bodyChanged.snapshotFingerprint,
    report.snapshotFingerprint,
    "body-only changes with identical structural metadata must not affect the inventory fingerprint"
  );
}

async function assertMetadataOnlyContractRejectsUnsafeValues(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-contract-negative-");
  const input = readyInventoryInput(fixture);
  const report = buildStorageInventoryReport(input);
  const unknownBodyValue = "UNKNOWN_BODY_VALUE_MUST_NOT_BE_ECHOED";
  const absolutePathValue = "/private/ABSOLUTE_PATH_VALUE_MUST_NOT_BE_ECHOED";
  const secretValue = "SECRET_VALUE_MUST_NOT_BE_ECHOED";

  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      unknownNarrative: unknownBodyValue
    }),
    "unexpected-field",
    unknownBodyValue
  );
  assertContractRejection(
    () => serializeStorageInventoryReport({
      ...report,
      unknownNarrative: unknownBodyValue
    }),
    "unexpected-field",
    unknownBodyValue
  );

  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      scope: {
        ...input.scope,
        pluginDir: absolutePathValue
      }
    }),
    "unsafe-string",
    absolutePathValue
  );
  assertContractRejection(
    () => serializeStorageInventoryReport({
      ...report,
      scope: {
        ...report.scope,
        pluginDir: absolutePathValue
      }
    }),
    "unsafe-string",
    absolutePathValue
  );

  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      apiKey: secretValue
    }),
    "unsafe-field",
    secretValue
  );
  assertContractRejection(
    () => serializeStorageInventoryReport({
      ...report,
      apiKey: secretValue
    }),
    "unsafe-field",
    secretValue
  );

  const privateReportCode = "private-native-session-abc123";
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      sources: input.sources.map((source, index) =>
        index === 0 ? { ...source, statusCode: privateReportCode } : source)
    }),
    "invalid-value",
    privateReportCode
  );
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      providers: input.providers.map((provider, index) =>
        index === 0 ? { ...provider, statusCode: privateReportCode } : provider)
    }),
    "invalid-value",
    privateReportCode
  );
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      sources: input.sources.map((source, index) =>
        index === 0 ? { ...source, generation: privateReportCode } : source)
    }),
    "invalid-value",
    privateReportCode
  );
  const unknownCodeFinding = {
    findingId: createStorageInventoryOpaqueRef("finding", "unknown-report-code"),
    category: "ambiguous",
    code: privateReportCode,
    severity: "warning",
    sourceId: "data-json",
    count: 1,
    blocksMigration: false,
    automaticActionAllowed: false
  } as const;
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      findings: [unknownCodeFinding],
      migrationPreview: {
        ...input.migrationPreview,
        status: "partial",
        candidateRecordCount: 1
      }
    }),
    "invalid-value",
    privateReportCode
  );
  const unsafeFindingId = {
    findingId: privateReportCode,
    category: "ambiguous",
    code: "conversation-session-unselected",
    severity: "warning",
    sourceId: "data-json",
    count: 1,
    blocksMigration: false,
    automaticActionAllowed: false
  } as const;
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      findings: [unsafeFindingId],
      migrationPreview: {
        ...input.migrationPreview,
        status: "partial",
        candidateRecordCount: 1
      }
    }),
    "invalid-value",
    privateReportCode
  );
  const blockingFinding = {
    findingId: createStorageInventoryOpaqueRef("finding", "blocking-id"),
    category: "corrupt",
    code: "path-outside-scan-root",
    severity: "blocking",
    sourceId: "data-json",
    count: 1,
    blocksMigration: true,
    automaticActionAllowed: false
  } as const;
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      findings: [blockingFinding],
      migrationPreview: {
        ...input.migrationPreview,
        status: "blocked",
        blockingFindingIds: [privateReportCode]
      }
    }),
    "invalid-value",
    privateReportCode
  );
  const relationRef = createStorageInventoryOpaqueRef("relation", "private-label");
  const relationTemplate = {
    kind: "conversation-authority",
    from: {
      sourceId: "data-json",
      entityType: "session",
      ref: relationRef
    },
    to: {
      sourceId: "conversations",
      entityType: "session",
      ref: relationRef
    },
    status: "linked"
  } as const;
  const metadataLabelFinding = {
    findingId: createStorageInventoryOpaqueRef("finding", "private-metadata-label"),
    category: "ambiguous",
    code: "conversation-session-unselected",
    severity: "warning",
    sourceId: "data-json",
    count: 1,
    metadata: [{ name: privateReportCode, value: 1 }],
    blocksMigration: false,
    automaticActionAllowed: false
  } as const;
  const privateLabelCases: Array<{ label: string; action: () => unknown }> = [
    {
      label: "relation.kind",
      action: () => validateStorageInventoryReportInput({
        ...input,
        relations: [{ ...relationTemplate, kind: privateReportCode }]
      })
    },
    {
      label: "entityType",
      action: () => validateStorageInventoryReportInput({
        ...input,
        relations: [{
          ...relationTemplate,
          from: {
            ...relationTemplate.from,
            entityType: privateReportCode
          }
        }]
      })
    },
    {
      label: "metric.name",
      action: () => validateStorageInventoryReportInput({
        ...input,
        sources: input.sources.map((source, index) =>
          index === 0
            ? {
              ...source,
              metrics: [{ name: privateReportCode, value: 1 }]
            }
            : source)
      })
    },
    {
      label: "finding.metadata.name",
      action: () => validateStorageInventoryReportInput({
        ...input,
        findings: [metadataLabelFinding],
        migrationPreview: {
          ...input.migrationPreview,
          status: "partial",
          candidateRecordCount: 1
        }
      })
    },
    {
      label: "source.schemaVersion",
      action: () => validateStorageInventoryReportInput({
        ...input,
        sources: input.sources.map((source, index) =>
          index === 0
            ? { ...source, schemaVersion: privateReportCode }
            : source)
      })
    }
  ];
  for (const testCase of privateLabelCases) {
    assertContractRejection(
      testCase.action,
      "invalid-value",
      privateReportCode
    );
  }

  const localErrorInput: StorageInventoryReportInput = {
    ...input,
    sources: input.sources.map((source, index) =>
      index === 0
        ? {
          ...source,
          status: "error",
          statusCode: "data-json-unavailable"
        }
        : source)
  };
  assertContractRejection(
    () => validateStorageInventoryReportInput(localErrorInput),
    "invalid-value",
    "data-json-unavailable"
  );

  const warningFinding = {
    findingId: createStorageInventoryOpaqueRef("finding", "warning-ready"),
    category: "ambiguous",
    code: "conversation-session-unselected",
    severity: "warning",
    sourceId: "data-json",
    count: 1,
    blocksMigration: false,
    automaticActionAllowed: false
  } as const;
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      findings: [warningFinding],
      migrationPreview: {
        ...input.migrationPreview,
        candidateRecordCount: 1
      }
    }),
    "invalid-value",
    warningFinding.code
  );

  const corruptWithoutFinding: StorageInventoryReportInput = {
    ...input,
    sources: input.sources.map((source, index) =>
      index === 0
        ? {
          ...source,
          status: "partial",
          statusCode: "data-session-invalid",
          corruptCount: 1
        }
        : source),
    migrationPreview: {
      ...input.migrationPreview,
      status: "partial"
    }
  };
  assertContractRejection(
    () => validateStorageInventoryReportInput(corruptWithoutFinding),
    "invalid-reference",
    "data-session-invalid"
  );

  const futureWithoutFinding: StorageInventoryReportInput = {
    ...input,
    sources: input.sources.map((source, index) =>
      index === 0
        ? {
          ...source,
          status: "partial",
          statusCode: "future-schema",
          futureSchemaCount: 1
        }
        : source),
    migrationPreview: {
      ...input.migrationPreview,
      status: "partial"
    }
  };
  assertContractRejection(
    () => validateStorageInventoryReportInput(futureWithoutFinding),
    "invalid-reference",
    "future-schema"
  );

  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      findings: [warningFinding],
      migrationPreview: {
        ...input.migrationPreview,
        status: "partial",
        candidateRecordCount: 0
      }
    }),
    "invalid-value",
    warningFinding.code
  );
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      sources: input.sources.map((source, index) =>
        index === 0 ? { ...source, recordCount: 1 } : source)
    }),
    "invalid-value",
    "forged-retain-count"
  );
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      migrationPreview: {
        ...input.migrationPreview,
        wouldCreateRecordCount: 1
      }
    }),
    "invalid-value",
    "forged-create-count"
  );
  assertContractRejection(
    () => validateStorageInventoryReportInput({
      ...input,
      providers: input.providers.map((provider, index) =>
        index === 0
          ? { ...provider, inspectedCount: 1 }
          : provider)
    }),
    "invalid-value",
    "forged-provider-count"
  );
}

async function assertScannerIsReadOnlyAndBlocksBoundarySymlinks(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-readonly-");
  const outside = await mkdtemp(path.join(tmpdir(), "echoink-storage-inventory-outside-"));
  await writeDataJson(fixture, []);
  await writeFile(path.join(outside, "outside.txt"), SECRET, "utf8");
  await symlink(outside, path.join(fixture.rawPath, "outside-link"));
  const calls: string[] = [];
  const recordingFs = readOnlyFs({
    onCall: (name, filePath) => calls.push(`${name}:${filePath}`)
  });
  const before = await directoryDigest(fixture.pluginDataPath);
  for (const pluginDir of [
    "../outside",
    "nested/plugin",
    ".obsidian/plugins/codex-echoink"
  ]) {
    const callCountBefore = calls.length;
    const blocked = buildStorageInventoryReport(
      await scanStorageInventory({
        ...scanOptions(fixture, { fs: recordingFs }),
        pluginDir
      })
    );
    assertBlockingFinding(blocked, "path-outside-scan-root");
    assert.equal(blocked.migrationPreview.status, "blocked");
    assert.equal(
      calls.length,
      callCountBefore,
      `unsafe pluginDir ${pluginDir} must be rejected before filesystem access`
    );
  }

  const report = await scanAndBuild(fixture, { fs: recordingFs });
  const after = await directoryDigest(fixture.pluginDataPath);

  assertFinding(report, "symlink-blocked");
  assert.equal(after, before, "dry-run must leave every scanned byte unchanged");
  assert.ok(calls.length > 0);
  assert.equal(calls.some((call) => /write|append|rename|remove|unlink|mkdir/i.test(call)), false);
  assert.equal(report.safetyReceipt.readOnly, true);
  assert.equal(report.safetyReceipt.actionsApplied, 0);
  assert.equal(report.safetyReceipt.deletionsApplied, 0);
  assert.equal(report.safetyReceipt.writesOutsideOutputDir, 0);
}

async function assertReportOrderingAndFingerprintAreDeterministic(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-deterministic-");
  await writeDataJson(fixture, ["conversation-b", "conversation-a"]);
  await writeConversation(fixture, "conversation-b", [message("message-b", "assistant")]);
  await writeConversation(fixture, "conversation-a", [message("message-a", "user")]);
  await writeConversationIndex(fixture, [
    conversationSummary("conversation-b", 1),
    conversationSummary("conversation-a", 1)
  ]);
  const reverseFs = readOnlyFs({
    reorderEntries: (entries) => [...entries].reverse()
  });

  const firstInput = await scanStorageInventory(scanOptions(fixture, { fs: reverseFs }));
  const secondInput = await scanStorageInventory({
    ...scanOptions(fixture),
    now: () => FIXED_NOW + 86_400_000
  });
  const first = buildStorageInventoryReport(firstInput);
  const second = buildStorageInventoryReport(secondInput);
  const firstFingerprint = storageInventorySnapshotFingerprint(first);
  const secondFingerprint = storageInventorySnapshotFingerprint(second);

  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.equal(firstFingerprint, secondFingerprint);
  assert.equal(first.snapshotFingerprint, second.snapshotFingerprint);
  assert.equal(
    serializeStorageInventoryReport({ ...first, generatedAt: 0 }),
    serializeStorageInventoryReport({ ...second, generatedAt: 0 })
  );

  await writeConversation(fixture, "conversation-a", [
    message("message-a", "user"),
    message("message-a-2", "assistant")
  ]);
  const changed = await scanAndBuild(fixture);
  assert.notEqual(changed.snapshotFingerprint, first.snapshotFingerprint);

  await assertStorageInventoryCliExitCodes(fixture);
}

async function assertStructuralMetadataChangesFingerprintWithStableStats(): Promise<void> {
  const fixture = await createFixture("echoink-storage-inventory-structural-fingerprint-");
  await writeDataJson(fixture, ["conversation-a"]);
  await writeConversation(fixture, "conversation-a", [
    message("message-a", "user")
  ]);
  await writeConversationIndex(fixture, [
    conversationSummary("conversation-a", 1)
  ]);
  const messagesPath = path.join(
    fixture.conversationsPath,
    "sessions",
    "conversation-a",
    "messages.jsonl"
  );
  const conversationBefore = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  await rewriteWithStableStats(messagesPath, (source) => {
    const row = JSON.parse(source.trim()) as Record<string, unknown>;
    row.id = "message-b";
    return `${JSON.stringify(row)}\n`;
  });
  const conversationAfter = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  assert.notEqual(
    conversationAfter.snapshotFingerprint,
    conversationBefore.snapshotFingerprint,
    "same-stat Conversation message ID changes must affect the fingerprint"
  );

  const runPath = path.join(fixture.runsPath, "run-fingerprint.jsonl");
  await writeRun(fixture, "run-fingerprint", [
    runEvent("run-fingerprint", 1, "run.started"),
    runEvent("run-fingerprint", 2, "run.completed")
  ]);
  const runBefore = await scanAndBuild(fixture, { nativeScope: "none" });
  await rewriteWithStableStats(
    runPath,
    (source) => source.replace("\"run.started\"", "\"run.created\"")
  );
  const runAfter = await scanAndBuild(fixture, { nativeScope: "none" });
  assert.notEqual(
    runAfter.snapshotFingerprint,
    runBefore.snapshotFingerprint,
    "same-stat Run event type changes must affect the fingerprint"
  );

  const indexed = nativeRecord(
    "native-fingerprint",
    "codex-cli",
    "thread-fingerprint",
    {
      native: {
        ...nativeRecord(
          "native-fingerprint-source",
          "codex-cli",
          "thread-fingerprint"
        ).native,
        transport: "acp-stdio"
      }
    }
  );
  await writeNativeIndex(fixture, [indexed]);
  await writeNativeEvents(fixture, [
    { type: "upsert", record: indexed, createdAt: 1 }
  ]);
  const nativeBefore = await scanAndBuild(fixture, { nativeScope: "none" });
  const changed = structuredClone(indexed);
  changed.policy.historyAuthority = "backend";
  const indexPath = path.join(
    fixture.nativePath,
    "native-executions-index.json"
  );
  const eventsPath = path.join(
    fixture.nativePath,
    "native-executions.jsonl"
  );
  await rewritePairWithStableStats(
    [
      {
        filePath: indexPath,
        write: () => writeJson(indexPath, {
          version: 2,
          updatedAt: 10,
          records: [changed]
        })
      },
      {
        filePath: eventsPath,
        write: () => writeJsonl(eventsPath, [
          { type: "upsert", record: changed, createdAt: 1 }
        ])
      }
    ]
  );
  const nativeAfter = await scanAndBuild(fixture, { nativeScope: "none" });
  assert.notEqual(
    nativeAfter.snapshotFingerprint,
    nativeBefore.snapshotFingerprint,
    "same-stat Native policy changes must affect the fingerprint"
  );

  const transportChanged = structuredClone(changed);
  transportChanged.native.transport = "acp-httpx";
  await rewritePairWithStableStats(
    [
      {
        filePath: indexPath,
        write: () => writeJson(indexPath, {
          version: 2,
          updatedAt: 10,
          records: [transportChanged]
        })
      },
      {
        filePath: eventsPath,
        write: () => writeJsonl(eventsPath, [
          { type: "upsert", record: transportChanged, createdAt: 1 }
        ])
      }
    ]
  );
  const nativeTransportAfter = await scanAndBuild(
    fixture,
    { nativeScope: "none" }
  );
  assert.notEqual(
    nativeTransportAfter.snapshotFingerprint,
    nativeAfter.snapshotFingerprint,
    "same-stat Native transport changes must affect the fingerprint"
  );

  await assertConversationPayloadPointerFingerprintWithStableStats();
  await assertContextIdentityFingerprintWithStableStats();
}

async function assertConversationPayloadPointerFingerprintWithStableStats(): Promise<void> {
  const fixture = await createFixture(
    "echoink-storage-inventory-payload-pointer-fingerprint-"
  );
  const sessionId = "conversation-pointer-fingerprint";
  const activeCommitId = "commit-pointer-aa";
  const previousCommitId = "commit-pointer-bb";
  const activePayloadKey = conversationPayloadKey(activeCommitId);
  const previousPayloadKey = conversationPayloadKey(previousCommitId);
  const payloadMessages = [message("pointer-message", "assistant")];
  const payloadSnapshots = [{
    sessionId,
    contextId: "context-pointer",
    generation: 2,
    version: "snapshot:pointer",
    rollingSummary: SECRET,
    sourceMessageCount: 1,
    createdAt: 1,
    updatedAt: 2
  }];
  await writeDataJson(fixture, [sessionId]);
  await writeCommittedConversation(fixture, {
    sessionId,
    commitId: activeCommitId,
    payloadKey: activePayloadKey,
    previousPayloadKey,
    messages: payloadMessages,
    contextId: "context-pointer",
    generation: 2
  });
  await writeConversationIndex(fixture, [conversationSummary(sessionId, 1)]);
  const sessionPath = path.join(
    fixture.conversationsPath,
    "sessions",
    sessionId
  );
  await writeJsonl(
    path.join(
      sessionPath,
      "context-payloads",
      previousPayloadKey,
      "messages.jsonl"
    ),
    payloadMessages
  );
  await writeJsonl(
    path.join(
      sessionPath,
      "context-payloads",
      previousPayloadKey,
      "snapshots.jsonl"
    ),
    payloadSnapshots
  );
  const before = await scanAndBuild(fixture, { nativeScope: "none" });
  const metadataPath = path.join(sessionPath, "metadata.json");
  await rewriteWithStableStats(metadataPath, (source) => {
    const metadata = JSON.parse(source) as Record<string, unknown>;
    metadata.commitId = previousCommitId;
    metadata.payloadKey = previousPayloadKey;
    metadata.previousPayloadKey = activePayloadKey;
    return `${JSON.stringify(metadata, null, 2)}\n`;
  });
  const after = await scanAndBuild(fixture, { nativeScope: "none" });

  assert.notEqual(
    after.snapshotFingerprint,
    before.snapshotFingerprint,
    "same-stat active/previous pointer swaps must affect the fingerprint"
  );
}

async function assertContextIdentityFingerprintWithStableStats(): Promise<void> {
  const fixture = await createFixture(
    "echoink-storage-inventory-context-identity-fingerprint-"
  );
  const sessionId = "conversation-context-fingerprint";
  await writeDataJson(fixture, [sessionId]);
  await writeConversation(fixture, sessionId, [
    message("context-message", "user")
  ]);
  await writeConversationIndex(fixture, [conversationSummary(sessionId, 1)]);
  const sessionPath = path.join(
    fixture.conversationsPath,
    "sessions",
    sessionId
  );
  const metadataPath = path.join(sessionPath, "metadata.json");
  const snapshotsPath = path.join(sessionPath, "snapshots.jsonl");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
    string,
    unknown
  >;
  metadata.generation = 1;
  metadata.contextId = "context-a";
  metadata.contextStartsAfterMessageId = "boundary-a";
  metadata.commitId = "commit-a";
  metadata.workspaceFingerprint = "workspace-a";
  metadata.contextSnapshot = {
    ...(metadata.contextSnapshot as Record<string, unknown>),
    contextId: "snapshot-a",
    generation: 1
  };
  metadata.backendBindings = {
    codex: {
      backendId: "codex-cli",
      syncedSessionRevision: 1,
      workspaceFingerprint: "binding-workspace-a",
      contextCursor: {
        syncedSessionRevision: 1,
        sessionGeneration: 1,
        contextId: "cursor-a",
        snapshotVersion: "snapshot-a"
      },
      lastUsedAt: 2
    }
  };
  await writeJson(metadataPath, metadata);
  await writeJsonl(snapshotsPath, [{
    sessionId,
    contextId: "snapshot-a",
    generation: 1,
    version: `snapshot:${sessionId}`,
    rollingSummary: SECRET,
    sourceMessageCount: 1,
    createdAt: 1,
    updatedAt: 2
  }]);

  const before = await scanAndBuild(fixture, { nativeScope: "none" });
  await rewriteWithStableStats(metadataPath, (source) => {
    const next = JSON.parse(source) as Record<string, unknown>;
    next.contextId = "context-b";
    next.contextStartsAfterMessageId = "boundary-b";
    next.commitId = "commit-b";
    next.workspaceFingerprint = "workspace-b";
    return `${JSON.stringify(next, null, 2)}\n`;
  });
  const contextChanged = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  assert.notEqual(
    contextChanged.snapshotFingerprint,
    before.snapshotFingerprint,
    "same-stat Conversation context identity changes must affect the fingerprint"
  );

  await rewriteWithStableStats(metadataPath, (source) => {
    const next = JSON.parse(source) as Record<string, unknown>;
    const bindings = next.backendBindings as Record<
      string,
      Record<string, unknown>
    >;
    const binding = bindings.codex;
    binding.workspaceFingerprint = "binding-workspace-b";
    const cursor = binding.contextCursor as Record<string, unknown>;
    cursor.sessionGeneration = 2;
    cursor.contextId = "cursor-b";
    return `${JSON.stringify(next, null, 2)}\n`;
  });
  const bindingChanged = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  assert.notEqual(
    bindingChanged.snapshotFingerprint,
    contextChanged.snapshotFingerprint,
    "same-stat binding workspace/cursor changes must affect the fingerprint"
  );

  await rewriteWithStableStats(snapshotsPath, (source) => {
    const snapshot = JSON.parse(source.trim()) as Record<string, unknown>;
    snapshot.contextId = "snapshot-b";
    snapshot.generation = 2;
    return `${JSON.stringify(snapshot)}\n`;
  });
  const snapshotChanged = await scanAndBuild(fixture, {
    nativeScope: "none"
  });
  assert.notEqual(
    snapshotChanged.snapshotFingerprint,
    bindingChanged.snapshotFingerprint,
    "same-stat snapshot context/generation changes must affect the fingerprint"
  );
}

async function rewriteWithStableStats(
  filePath: string,
  transform: (source: string) => string
): Promise<void> {
  const before = await lstat(filePath);
  const source = await readFile(filePath, "utf8");
  const next = transform(source);
  assert.equal(next.length, source.length, "same-stat fixture must preserve byte length");
  await writeFile(filePath, next, "utf8");
  await utimes(filePath, before.atime, before.mtime);
}

async function rewritePairWithStableStats(
  entries: Array<{ filePath: string; write: () => Promise<void> }>
): Promise<void> {
  const before = await Promise.all(entries.map(async (entry) => ({
    entry,
    stats: await lstat(entry.filePath)
  })));
  for (const item of before) {
    await item.entry.write();
    const after = await lstat(item.entry.filePath);
    assert.equal(
      after.size,
      item.stats.size,
      "same-stat fixture must preserve byte length"
    );
    await utimes(
      item.entry.filePath,
      item.stats.atime,
      item.stats.mtime
    );
  }
}

async function assertStorageInventoryCliExitCodes(fixture: Fixture): Promise<void> {
  const successOutput = path.join(fixture.vaultPath, "inventory-success");
  const successStdout: string[] = [];
  const successStderr: string[] = [];
  const success = await runStorageInventoryCli([
    "--vault", fixture.vaultPath,
    "--output-dir", successOutput,
    "--native-scope", "none",
    "--format", "both"
  ], {
    scan: async () => readyInventoryInput(fixture),
    stdout: (text) => successStdout.push(text),
    stderr: (text) => successStderr.push(text)
  });

  assert.equal(success, STORAGE_INVENTORY_EXIT_CODES.success);
  assert.equal(successStderr.length, 0);
  assert.match(successStdout.join(""), /Storage inventory complete/);
  const [jsonOutput, markdownOutput] = await Promise.all([
    readFile(
      path.join(successOutput, STORAGE_INVENTORY_OUTPUT_FILES.json),
      "utf8"
    ),
    readFile(
      path.join(successOutput, STORAGE_INVENTORY_OUTPUT_FILES.markdown),
      "utf8"
    )
  ]);
  const committedJson = JSON.parse(jsonOutput) as {
    reportId?: unknown;
    snapshotFingerprint?: unknown;
  };
  const reportId = String(committedJson.reportId ?? "");
  const snapshotFingerprint = String(committedJson.snapshotFingerprint ?? "");
  assert.match(reportId, /^storage-inventory-[a-f0-9]{24}$/);
  assert.match(snapshotFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.ok(markdownOutput.includes(reportId));
  assert.ok(markdownOutput.includes(snapshotFingerprint));

  const failedOutput = path.join(fixture.vaultPath, "inventory-failed");
  const failureStderr: string[] = [];
  const partial = await runStorageInventoryCli([
    "--vault", fixture.vaultPath,
    "--output-dir", failedOutput,
    "--native-scope", "none"
  ], {
    scan: async () => {
      throw new Error(SECRET);
    },
    stdout: () => undefined,
    stderr: (text) => failureStderr.push(text)
  });

  assert.equal(partial, STORAGE_INVENTORY_EXIT_CODES.partial);
  assert.doesNotMatch(failureStderr.join(""), new RegExp(SECRET));

  const inconsistentOutput = path.join(fixture.vaultPath, "inventory-inconsistent");
  const inconsistent = await runStorageInventoryCli([
    "--vault", fixture.vaultPath,
    "--output-dir", inconsistentOutput,
    "--native-scope", "none"
  ], {
    scan: async () => {
      const ready = readyInventoryInput(fixture);
      return {
        ...ready,
        sources: ready.sources.map((source, index) =>
          index === 0
            ? {
              ...source,
              status: "error" as const,
              statusCode: "data-json-unavailable"
            }
            : source)
      };
    },
    stdout: () => undefined,
    stderr: () => undefined
  });
  assert.equal(inconsistent, STORAGE_INVENTORY_EXIT_CODES.partial);
  assert.notEqual(inconsistent, STORAGE_INVENTORY_EXIT_CODES.success);

  const blocked = await runStorageInventoryCli([
    "--vault", fixture.vaultPath
  ], {
    scan: async () => {
      assert.fail("usage-blocked CLI must not start a scan");
    },
    stdout: () => undefined,
    stderr: () => undefined
  });

  assert.equal(blocked, STORAGE_INVENTORY_EXIT_CODES.usageBlocked);

  const boundaryBlocked = await runStorageInventoryCli([
    "--vault", fixture.vaultPath,
    "--output-dir", path.join(fixture.pluginDataPath, "inventory-report")
  ], {
    scan: async () => {
      assert.fail("unsafe output boundary must be rejected before scan");
    },
    stdout: () => undefined,
    stderr: () => undefined
  });
  assert.equal(boundaryBlocked, STORAGE_INVENTORY_EXIT_CODES.usageBlocked);
}

interface Fixture {
  vaultPath: string;
  pluginDataPath: string;
  conversationsPath: string;
  historyPath: string;
  runsPath: string;
  nativePath: string;
  rawPath: string;
}

type ScanOverrides = Partial<{
  fs: ReadOnlyFs;
  nativeScope: StorageInventoryOptions["nativeScope"];
  nativeProviderProbes: Partial<Record<NativeProviderId, NativeProviderProbe>>;
}>;

async function createFixture(prefix: string): Promise<Fixture> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), prefix));
  const pluginDataPath = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_DIR);
  const fixture = {
    vaultPath,
    pluginDataPath,
    conversationsPath: path.join(pluginDataPath, "conversations"),
    historyPath: path.join(pluginDataPath, "history"),
    runsPath: path.join(pluginDataPath, "harness-runs"),
    nativePath: path.join(pluginDataPath, "harness-native-executions"),
    rawPath: path.join(pluginDataPath, "raw")
  };
  await Promise.all([
    mkdir(path.join(fixture.conversationsPath, "sessions"), { recursive: true }),
    mkdir(path.join(fixture.historyPath, "sessions"), { recursive: true }),
    mkdir(fixture.runsPath, { recursive: true }),
    mkdir(fixture.nativePath, { recursive: true }),
    mkdir(fixture.rawPath, { recursive: true })
  ]);
  await writeDataJson(fixture, []);
  await writeConversationIndex(fixture, []);
  await writeEmptyHistoryV2(fixture);
  await writeNativeIndex(fixture, []);
  await writeNativeEvents(fixture, []);
  return fixture;
}

async function scanAndBuild(
  fixture: Fixture,
  overrides: ScanOverrides = {}
): Promise<StorageInventoryReport> {
  return buildStorageInventoryReport(
    await scanStorageInventory(scanOptions(fixture, overrides))
  );
}

function scanOptions(
  fixture: Fixture,
  overrides: ScanOverrides = {}
): StorageInventoryOptions {
  return {
    vaultPath: fixture.vaultPath,
    pluginDir: PLUGIN_DIR,
    now: () => FIXED_NOW,
    ...overrides
  };
}

function readyInventoryInput(fixture: Fixture): StorageInventoryReportInput {
  const source = (sourceId: StorageInventorySource["sourceId"]): StorageInventorySource => ({
    sourceId,
    status: "scanned",
    schemaVersion: null,
    recordCount: 0,
    fileCount: 0,
    byteCount: 0,
    timeRange: { oldestAt: null, newestAt: null },
    missingCount: 0,
    corruptCount: 0,
    futureSchemaCount: 0,
    generation: null
  });
  const capabilities: StorageInventoryProviderSnapshot["capabilities"] = {
    enumerate: "unknown",
    inspectExistence: "unknown",
    resume: "unknown",
    archive: "unknown",
    delete: "unknown"
  };
  const provider = (
    providerId: StorageInventoryProviderSnapshot["providerId"]
  ): StorageInventoryProviderSnapshot => ({
    providerId,
    status: "unsupported",
    nativeScope: "none",
    capabilities,
    linkedCount: 0,
    inspectedCount: 0,
    existingCount: 0,
    missingCount: 0,
    unownedCandidateCount: 0,
    statusCode: "native-scope-none"
  });

  return {
    generatedAt: FIXED_NOW,
    scope: {
      vaultRef: createStorageInventoryOpaqueRef("vault", fixture.vaultPath),
      pluginDir: PLUGIN_DIR,
      nativeScope: "none"
    },
    sources: [
      source("data-json"),
      source("conversations"),
      source("history"),
      source("harness-runs"),
      source("run-record-retention"),
      source("raw-gc-quarantine"),
      source("record-mutations"),
      source("native-store"),
      source("raw")
    ],
    providers: [
      provider("codex"),
      provider("opencode"),
      provider("hermes")
    ],
    relations: [],
    findings: [],
    migrationPreview: {
      status: "ready",
      blockingFindingIds: [],
      candidateRecordCount: 0,
      wouldCreateRecordCount: 0,
      wouldUpdateRecordCount: 0,
      wouldRetainRecordCount: 0,
      destructiveActionCount: 0,
      automaticActionAllowed: false
    }
  };
}

async function writeDataJson(
  fixture: Fixture,
  sessionIds: string[],
  extra: Record<string, unknown> = {}
): Promise<void> {
  await writeJson(path.join(fixture.pluginDataPath, "data.json"), {
    settingsVersion: 29,
    activeSessionId: sessionIds[0] ?? "",
    sessions: sessionIds.map((id) => ({
      id,
      kind: id.startsWith("knowledge") ? "knowledge-base" : "chat",
      title: extra.title ?? `title:${id}`,
      cwd: fixture.vaultPath,
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })),
    knowledgeBase: {
      sessionId: sessionIds.find((id) => id.startsWith("knowledge")) ?? "",
      historyRetentionDays: 30
    },
    ...extra
  });
}

async function writeConversation(
  fixture: Fixture,
  sessionId: string,
  messages: Array<Record<string, unknown>>,
  kind: "chat" | "knowledge-base" = "chat"
): Promise<void> {
  const sessionPath = path.join(fixture.conversationsPath, "sessions", sessionId);
  await mkdir(sessionPath, { recursive: true });
  await writeJson(path.join(sessionPath, "metadata.json"), {
    id: sessionId,
    title: `title:${sessionId}`,
    kind,
    cwd: fixture.vaultPath,
    revision: 1,
    contextSnapshot: {
      sessionId,
      version: `snapshot:${sessionId}`,
      rollingSummary: SECRET,
      sourceMessageCount: messages.length,
      createdAt: 1,
      updatedAt: 2
    },
    createdAt: 1,
    updatedAt: 2
  });
  await writeJsonl(path.join(sessionPath, "messages.jsonl"), messages);
  await writeJsonl(path.join(sessionPath, "snapshots.jsonl"), [{
    sessionId,
    version: `snapshot:${sessionId}`,
    rollingSummary: SECRET,
    sourceMessageCount: messages.length,
    createdAt: 1,
    updatedAt: 2
  }]);
}

async function writeCommittedConversation(
  fixture: Fixture,
  input: {
    sessionId: string;
    commitId: string;
    payloadKey: string;
    payloadVersion?: 2;
    previousPayloadKey?: string;
    previousPayloadCommitId?: string;
    messages: Array<Record<string, unknown>>;
    contextId?: string;
    generation?: number;
    workspaceFingerprint?: string;
    omitPayloadFiles?: boolean;
  }
): Promise<void> {
  const sessionPath = path.join(
    fixture.conversationsPath,
    "sessions",
    input.sessionId
  );
  await mkdir(path.join(sessionPath, "context-payloads"), { recursive: true });
  const generation = input.generation ?? 1;
  const snapshot = committedConversationSnapshot({
    sessionId: input.sessionId,
    contextId: input.contextId,
    generation,
    messageCount: input.messages.length
  });
  await writeJson(path.join(sessionPath, "metadata.json"), {
    id: input.sessionId,
    title: `title:${input.sessionId}`,
    kind: "chat",
    cwd: fixture.vaultPath,
    revision: generation,
    generation,
    ...(input.contextId ? { contextId: input.contextId } : {}),
    commitId: input.commitId,
    ...(input.workspaceFingerprint
      ? { workspaceFingerprint: input.workspaceFingerprint }
      : {}),
    ...(input.payloadVersion ? { payloadVersion: input.payloadVersion } : {}),
    payloadKey: input.payloadKey,
    ...(input.previousPayloadKey
      ? { previousPayloadKey: input.previousPayloadKey }
      : {}),
    ...(input.previousPayloadCommitId
      ? { previousPayloadCommitId: input.previousPayloadCommitId }
      : {}),
    contextSnapshot: snapshot,
    createdAt: 1,
    updatedAt: 2
  });
  if (input.omitPayloadFiles) return;
  await writeJsonl(
    path.join(
      sessionPath,
      "context-payloads",
      input.payloadKey,
      "messages.jsonl"
    ),
    input.messages
  );
  await writeJsonl(
    path.join(
      sessionPath,
      "context-payloads",
      input.payloadKey,
      "snapshots.jsonl"
    ),
    [snapshot]
  );
}

function committedConversationSnapshot(input: {
  sessionId: string;
  contextId?: string;
  generation: number;
  messageCount: number;
}): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    ...(input.contextId ? { contextId: input.contextId } : {}),
    generation: input.generation,
    version: `snapshot:${input.sessionId}`,
    rollingSummary: SECRET,
    sourceMessageCount: input.messageCount,
    createdAt: 1,
    updatedAt: 2
  };
}

function conversationPayloadKey(commitId: string): string {
  return `payload-${createHash("sha256").update(commitId).digest("hex")}`;
}

async function writeConversationIndex(
  fixture: Fixture,
  sessions: unknown[]
): Promise<void> {
  await writeJson(path.join(fixture.conversationsPath, "index.json"), {
    version: 1,
    updatedAt: 2,
    sessions
  });
}

async function writeHistoryDay(
  fixture: Fixture,
  sessionId: string,
  date: string,
  messages: Array<Record<string, unknown>>
): Promise<void> {
  const sessionPath = path.join(fixture.historyPath, "sessions", sessionId);
  await mkdir(sessionPath, { recursive: true });
  await writeJsonl(path.join(sessionPath, `${date}.jsonl`), messages);
}

async function writeHistoryIndex(
  fixture: Fixture,
  sessions: unknown[]
): Promise<void> {
  await rm(path.join(fixture.historyPath, "v2"), {
    recursive: true,
    force: true
  });
  await writeJson(path.join(fixture.historyPath, "index.json"), {
    version: 1,
    updatedAt: 2,
    sessions
  });
}

async function writeEmptyHistoryV2(fixture: Fixture): Promise<void> {
  const generationId = "g-fixture-empty";
  const root = path.join(fixture.historyPath, "v2");
  const generationRoot = path.join(
    root,
    "generations",
    generationId
  );
  const index = {
    version: 2,
    updatedAt: FIXED_NOW,
    sessions: []
  };
  const suppressions = {
    version: 2,
    kind: "knowledge-history-suppressions",
    revision: stableFixtureRevision({
      version: 2,
      kind: "knowledge-history-suppressions",
      entries: []
    }),
    updatedAt: FIXED_NOW,
    entries: []
  };
  const files: unknown[] = [];
  const indexRevision = stableFixtureRevision(index);
  const manifest = {
    version: 2,
    kind: "knowledge-history-generation",
    generationId,
    createdAt: FIXED_NOW,
    sourceRevision: stableFixtureRevision([]),
    suppressionRevision: suppressions.revision,
    retentionDays: null,
    retentionCutoffDate: null,
    indexRevision,
    projectionRevision: stableFixtureRevision({
      indexRevision,
      suppressionRevision: suppressions.revision,
      files
    }),
    sessionCount: 0,
    dayCount: 0,
    messageCount: 0,
    files
  };
  await mkdir(generationRoot, { recursive: true });
  await writeJson(path.join(generationRoot, "index.json"), index);
  await writeJson(
    path.join(generationRoot, "suppressions.json"),
    suppressions
  );
  await writeJson(path.join(generationRoot, "manifest.json"), manifest);
  await writeJson(path.join(root, "suppressions.json"), suppressions);
  await writeJson(path.join(root, "active.json"), {
    version: 2,
    kind: "knowledge-history-active",
    generationId,
    generationRevision: stableFixtureRevision(manifest),
    sourceRevision: manifest.sourceRevision,
    suppressionRevision: suppressions.revision,
    publishedAt: FIXED_NOW
  });
}

async function writeHistoryV2Projection(
  fixture: Fixture,
  sessionId: string,
  canonicalMessages: Array<Record<string, unknown>>,
  references: Array<Record<string, unknown>>
): Promise<void> {
  const generationId = "g-fixture-projection";
  const root = path.join(fixture.historyPath, "v2");
  await rm(root, { recursive: true, force: true });
  const generationRoot = path.join(
    root,
    "generations",
    generationId
  );
  const date = localFixtureDateKey(
    Number(canonicalMessages[0]?.createdAt ?? 1)
  );
  const relativePath = path.posix.join(
    "sessions",
    sessionId,
    `${date}.jsonl`
  );
  const dayText =
    references.map((reference) => JSON.stringify(reference)).join("\n")
    + (references.length ? "\n" : "");
  const daySummary = {
    date,
    messageCount: references.length,
    userMessageCount: 0,
    assistantMessageCount: 0,
    processMessageCount: 0,
    failedMessageCount: 0,
    firstMessageAt: 1,
    lastMessageAt: 1
  };
  const index = {
    version: 2,
    updatedAt: FIXED_NOW,
    sessions: [{
      sessionId,
      title: `title:${sessionId}`,
      kind: "knowledge-base",
      activeDate: date,
      messageCount: references.length,
      dayCount: 1,
      updatedAt: 2,
      days: [daySummary]
    }]
  };
  const suppressions = {
    version: 2,
    kind: "knowledge-history-suppressions",
    revision: stableFixtureRevision({
      version: 2,
      kind: "knowledge-history-suppressions",
      entries: []
    }),
    updatedAt: FIXED_NOW,
    entries: []
  };
  const files = [{
    relativePath,
    digest: `sha256:${createHash("sha256")
      .update(dayText)
      .digest("hex")}`,
    rowCount: references.length
  }];
  const indexRevision = stableFixtureRevision(index);
  const sourceRevision = stableFixtureRevision([{
    id: sessionId,
    title: `title:${sessionId}`,
    kind: "knowledge-base",
    historyActiveDate: null,
    updatedAt: 2,
    messages: canonicalMessages.map((messageValue) => ({
      id: messageValue.id,
      revision: stableFixtureRevision(messageValue)
    }))
  }]);
  const manifest = {
    version: 2,
    kind: "knowledge-history-generation",
    generationId,
    createdAt: FIXED_NOW,
    sourceRevision,
    suppressionRevision: suppressions.revision,
    retentionDays: null,
    retentionCutoffDate: null,
    indexRevision,
    projectionRevision: stableFixtureRevision({
      indexRevision,
      suppressionRevision: suppressions.revision,
      files
    }),
    sessionCount: 1,
    dayCount: 1,
    messageCount: references.length,
    files
  };
  await mkdir(
    path.dirname(path.join(generationRoot, relativePath)),
    { recursive: true }
  );
  await writeFile(
    path.join(generationRoot, relativePath),
    dayText,
    "utf8"
  );
  await writeJson(path.join(generationRoot, "index.json"), index);
  await writeJson(
    path.join(generationRoot, "suppressions.json"),
    suppressions
  );
  await writeJson(path.join(generationRoot, "manifest.json"), manifest);
  await writeJson(path.join(root, "suppressions.json"), suppressions);
  await writeJson(path.join(root, "active.json"), {
    version: 2,
    kind: "knowledge-history-active",
    generationId,
    generationRevision: stableFixtureRevision(manifest),
    sourceRevision,
    suppressionRevision: suppressions.revision,
    publishedAt: FIXED_NOW
  });
}

function historyV2Reference(
  conversationId: string,
  messageValue: Record<string, unknown>
): Record<string, unknown> {
  return {
    version: 2,
    kind: "conversation-message",
    conversationId,
    messageId: messageValue.id,
    messageRevision: stableFixtureRevision(messageValue)
  };
}

function localFixtureDateKey(value: number): string {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function stableFixtureRevision(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortFixtureValue(value)))
    .digest("hex")}`;
}

function sortFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortFixtureValue);
  if (!value || typeof value !== "object") {
    return value === undefined ? null : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortFixtureValue(nested)])
  );
}

async function writeRun(
  fixture: Fixture,
  fileRunId: string,
  events: unknown[]
): Promise<void> {
  await writeJsonl(path.join(fixture.runsPath, `${fileRunId}.jsonl`), events);
}

async function writeNativeIndex(
  fixture: Fixture,
  records: unknown[],
  version = 2
): Promise<void> {
  await writeJson(path.join(fixture.nativePath, "native-executions-index.json"), {
    version,
    updatedAt: 10,
    records
  });
}

async function writeNativeEvents(
  fixture: Fixture,
  events: Array<Record<string, unknown>>
): Promise<void> {
  await writeJsonl(path.join(fixture.nativePath, "native-executions.jsonl"), events);
}

function message(id: string, role: "user" | "assistant"): Record<string, unknown> {
  return {
    id,
    role,
    text: `body:${id}`,
    createdAt: 1
  };
}

function conversationSummary(
  sessionId: string,
  messageCount: number,
  kind: "chat" | "knowledge-base" = "chat"
): Record<string, unknown> {
  return {
    sessionId,
    title: `title:${sessionId}`,
    kind,
    messageCount,
    updatedAt: 2
  };
}

function historySessionSummary(
  sessionId: string,
  days: Array<Record<string, unknown>>
): Record<string, unknown> {
  return {
    sessionId,
    title: "Knowledge",
    kind: "knowledge-base",
    activeDate: String(days[0]?.date ?? ""),
    messageCount: days.reduce((sum, day) => sum + Number(day.messageCount ?? 0), 0),
    dayCount: days.length,
    updatedAt: 2,
    days
  };
}

function historyDaySummary(date: string, messageCount: number): Record<string, unknown> {
  return {
    date,
    messageCount,
    userMessageCount: messageCount,
    assistantMessageCount: 0,
    processMessageCount: 0,
    failedMessageCount: 0,
    firstMessageAt: 1,
    lastMessageAt: 2
  };
}

function runEvent(runId: string, sequence: number, type: string): Record<string, unknown> {
  return {
    runId,
    sequence,
    source: "kernel",
    type,
    backendId: "codex-cli",
    createdAt: sequence
  };
}

function nativeRecord(
  id: string,
  backendId: string,
  nativeId: string,
  overrides: Partial<NativeExecutionRecord> = {}
): NativeExecutionRecord {
  const record: NativeExecutionRecord = {
    id,
    runId: `run:${id}`,
    sessionId: `session:${id}`,
    surface: "knowledge",
    workflow: "knowledge.maintain",
    native: {
      backendId,
      id: nativeId,
      kind: backendId === "codex-cli" ? "thread" : "session",
      persistence: "provider-persistent",
      deviceKey: "device",
      vaultId: "vault",
      createdAt: 1
    },
    policy: {
      historyAuthority: "echoink",
      mode: "ephemeral-run",
      preferredDisposition: ["delete"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    runOutcome: "success",
    localCommit: "committed",
    cleanup: "disposed",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt: 1,
    settledAt: 2,
    committedAt: 3,
    disposedAt: 4
  };
  return { ...record, ...overrides };
}

function sqliteQueryFromCall(
  call: { executable: string; args: string[] } | undefined
): string {
  assert.ok(call, "expected an injected SQLite call");
  assert.equal(call.args.length, 4);
  const sql = call.args[3];
  assert.equal(typeof sql, "string");
  return sql;
}

function assertMetadataOnlyProviderSelect(sql: string): void {
  const fromIndex = sql.indexOf(" FROM ");
  assert.ok(fromIndex > 0, `expected a SELECT ... FROM query; got ${sql}`);
  const projection = sql.slice(0, fromIndex).toLowerCase();
  assert.match(projection, /^select id,/);
  assert.match(projection, /\bas inventory_cwd\b/);
  assert.match(projection, /\bas inventory_created_at\b/);
  assert.match(projection, /\bas inventory_updated_at\b/);
  assert.doesNotMatch(projection, /\*/);
  for (const forbiddenColumn of [
    "title",
    "preview",
    "prompt",
    "message",
    "summary",
    "model_config",
    "system_prompt",
    "origin_json",
    "content",
    "text",
    "body"
  ]) {
    assert.equal(
      new RegExp(`\\b${forbiddenColumn}\\b`, "i").test(projection),
      false,
      `provider SQL must not select body column ${forbiddenColumn}`
    );
  }
}

function assertContractRejection(
  action: () => unknown,
  expectedCode: StorageInventoryContractError["code"],
  forbiddenValue: string
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof StorageInventoryContractError,
    `expected StorageInventoryContractError ${expectedCode}`
  );
  assert.equal(caught.code, expectedCode);
  assert.equal(
    caught.message.includes(forbiddenValue),
    false,
    "contract rejection must not echo the rejected value"
  );
}

function assertFinding(report: StorageInventoryReport, code: string): void {
  const matching = report.findings.filter((finding) => finding.code === code);
  assert.ok(
    matching.length > 0,
    `expected finding ${code}; got ${JSON.stringify(report.findings)}`
  );
  for (const finding of matching) {
    assert.equal(finding.automaticActionAllowed, false);
  }
}

function assertBlockingFinding(report: StorageInventoryReport, code: string): void {
  const matching = report.findings.filter((finding) => finding.code === code);
  assert.ok(
    matching.length > 0,
    `expected blocking finding ${code}; got ${JSON.stringify(report.findings)}`
  );
  for (const finding of matching) {
    assert.equal(finding.severity, "blocking");
    assert.equal(finding.blocksMigration, true);
    assert.equal(finding.automaticActionAllowed, false);
  }
  assert.equal(
    report.migrationPreview.blockingFindingIds.some((findingId) =>
      matching.some((finding) => finding.findingId === findingId)),
    true,
    `expected ${code} to block migration`
  );
}

function assertFindingCount(report: StorageInventoryReport, code: string, minimum: number): void {
  const matching = report.findings.filter((finding) => finding.code === code);
  assert.ok(
    matching.length >= minimum,
    `expected at least ${minimum} ${code} findings; got ${JSON.stringify(report.findings)}`
  );
  for (const finding of matching) {
    assert.equal(finding.automaticActionAllowed, false);
  }
}

function sourceStatus(report: StorageInventoryReport, sourceId: string): string {
  const source = report.sources.find((candidate) => candidate.sourceId === sourceId);
  return String(source?.status ?? "");
}

function hasOwnKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasOwnKeyDeep(item, key));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, key)
    || Object.values(record).some((item) => hasOwnKeyDeep(item, key));
}

function readOnlyFs(options: {
  onCall?: (name: string, filePath: string) => void;
  onReadFile?: (filePath: string) => void;
  reorderEntries?: (
    entries: Array<ReadOnlyDirEntry | string>
  ) => Array<ReadOnlyDirEntry | string>;
} = {}): ReadOnlyFs {
  return {
    async readFile(filePath: string, encoding?: BufferEncoding) {
      options.onCall?.("readFile", filePath);
      options.onReadFile?.(filePath);
      return encoding
        ? await readFile(filePath, encoding)
        : await readFile(filePath);
    },
    async readdir(filePath: string, readdirOptions?: { withFileTypes: true }) {
      options.onCall?.("readdir", filePath);
      const entries = readdirOptions?.withFileTypes
        ? await readdir(filePath, { withFileTypes: true })
        : await readdir(filePath);
      return options.reorderEntries?.([...entries]) ?? entries;
    },
    async lstat(filePath: string) {
      options.onCall?.("lstat", filePath);
      return await lstat(filePath);
    },
    async realpath(filePath: string) {
      options.onCall?.("realpath", filePath);
      return await realpath(filePath);
    }
  } as ReadOnlyFs;
}

async function directoryDigest(rootPath: string): Promise<string> {
  const hash = createHash("sha256");
  await appendDirectoryDigest(hash, rootPath, "");
  return hash.digest("hex");
}

async function appendDirectoryDigest(
  hash: ReturnType<typeof createHash>,
  absolutePath: string,
  relativePath: string
): Promise<void> {
  const metadata = await lstat(absolutePath);
  hash.update(`${relativePath}\0${metadata.mode}\0${metadata.size}\0${metadata.mtimeMs}\0`);
  if (metadata.isSymbolicLink()) {
    hash.update(`symlink:${await readlink(absolutePath)}\0`);
    return;
  }
  if (metadata.isFile()) return;
  if (!metadata.isDirectory()) return;
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    await appendDirectoryDigest(
      hash,
      path.join(absolutePath, entry.name),
      relativePath ? `${relativePath}/${entry.name}` : entry.name
    );
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
    "utf8"
  );
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
