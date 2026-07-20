import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { StoredSession } from "../../settings/settings";
import {
  createConversationContentRevision,
  createConversationDeletionTombstone,
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../../harness/conversation/conversation-store-v2";
import {
  conversationMigrationInventoryFromLegacySessions,
  conversationMigrationInventoryFromV2Commits,
  createConversationProductMessageRevision,
  historyMigrationInventoryFromReferences,
  inspectAndValidateConversationStoreMigration,
  legacyExternalOwnerEdges,
  prepareConversationStoreV2Migration,
  projectStoredSessionToConversationCommitV2
} from "../../harness/lifecycle/conversation-migration-projection";
import {
  RecordMigrationValidationError,
  assertRecordMigrationValidationProof,
  validateRecordMigration,
  type RecordMigrationValidationProof
} from "../../harness/lifecycle/record-migration-validator";

const BASE_TIME = 1_721_260_800_000;

export async function runHarnessV2RecordMigrationValidatorTests():
Promise<void> {
  assertExactConversationProjectionProducesTrustedProof();
  assertSameIdentityDifferentBodyIsQuarantinedWithoutLeakingBody();
  assertOrderAndOwnerDriftBlockValidation();
  assertHistoryReferencesRequireExactRevisionAndOrder();
  assertDeletionAuthorityCannotDisappearDuringCutover();
  assertUntrustedProofCannotAuthorizeCutover();
  assertLegacyUnknownFieldsAndExternalOwnersFailClosed();
  await assertDeletionTombstoneMigrationUsesDurableTargetAuthority();
  await assertLegacyConversationMigrationSnapshotIsReadOnly();
}

function assertExactConversationProjectionProducesTrustedProof(): void {
  const session = storedSession();
  const commit = projectStoredSessionToConversationCommitV2(session);
  assert.equal(commit.payload.messages[0].id, "message-secret-a");
  assert.equal(commit.payload.messages[1].id, "message-secret-b");
  assert.equal(commit.payload.messages[0].raw?.ref, "raw/secret-a.md");
  assert.equal(
    createConversationProductMessageRevision(session.messages[0]),
    createConversationProductMessageRevision(commit.payload.messages[0])
  );

  const source = conversationMigrationInventoryFromLegacySessions([session]);
  const target = conversationMigrationInventoryFromV2Commits([commit]);
  const result = validateRecordMigration(source, target);
  assert.equal(result.report.status, "ready");
  assert.equal(result.report.findings.length, 0);
  assert.ok(result.proof);
  assertRecordMigrationValidationProof(result.proof, {
    domain: "conversation",
    sourceFingerprint: source.fingerprint,
    targetFingerprint: target.fingerprint
  });
}

function assertSameIdentityDifferentBodyIsQuarantinedWithoutLeakingBody():
void {
  const sourceSession = storedSession();
  const targetSession = storedSession();
  targetSession.messages[0].text = "different secret body";
  const source = conversationMigrationInventoryFromLegacySessions(
    [sourceSession]
  );
  const target = conversationMigrationInventoryFromV2Commits([
    projectStoredSessionToConversationCommitV2(targetSession)
  ]);
  const result = validateRecordMigration(source, target);
  assert.equal(result.report.status, "blocked");
  assert.equal(result.proof, null);
  assert.ok(result.report.quarantine);
  assert.ok(
    result.report.findings.some((finding) =>
      finding.code === "subject-content-conflict"
      && finding.quarantined)
  );
  const serialized = JSON.stringify(result.report);
  assert.doesNotMatch(serialized, /conversation-secret/);
  assert.doesNotMatch(serialized, /message-secret/);
  assert.doesNotMatch(serialized, /different secret body/);
  assert.doesNotMatch(serialized, /original secret body/);
}

function assertOrderAndOwnerDriftBlockValidation(): void {
  const session = storedSession({
    diagnostics: true
  });
  const source = conversationMigrationInventoryFromLegacySessions([session]);
  const commit = projectStoredSessionToConversationCommitV2(session);
  const targetWithoutExternalOwners =
    conversationMigrationInventoryFromV2Commits([commit]);
  const missingOwners = validateRecordMigration(
    source,
    targetWithoutExternalOwners
  );
  assert.equal(missingOwners.report.status, "blocked");
  assert.ok(
    missingOwners.report.findings.some((finding) =>
      finding.code === "owner-missing-in-target")
  );

  const reorderedSession = storedSession({ diagnostics: true });
  reorderedSession.messages.reverse();
  const targetWithWrongOrder = conversationMigrationInventoryFromV2Commits(
    [projectStoredSessionToConversationCommitV2(reorderedSession)],
    "v2",
    {
      externalOwnerEdges: legacyExternalOwnerEdges([session])
    }
  );
  const reordered = validateRecordMigration(source, targetWithWrongOrder);
  assert.equal(reordered.report.status, "blocked");
  assert.ok(
    reordered.report.findings.some((finding) =>
      finding.code === "subject-order-mismatch")
  );

  const targetWithOwners = conversationMigrationInventoryFromV2Commits(
    [commit],
    "v2",
    {
      externalOwnerEdges: legacyExternalOwnerEdges([session])
    }
  );
  assert.equal(
    validateRecordMigration(source, targetWithOwners).report.status,
    "ready"
  );
}

function assertHistoryReferencesRequireExactRevisionAndOrder(): void {
  const revisionA = createConversationProductMessageRevision(
    storedSession().messages[0]
  );
  const source = historyMigrationInventoryFromReferences("v1", [{
    conversationId: "conversation-secret",
    messageId: "message-secret-a",
    messageRevision: revisionA,
    date: "2024-07-18",
    ordinal: 0
  }]);
  const exact = historyMigrationInventoryFromReferences("v2", [{
    conversationId: "conversation-secret",
    messageId: "message-secret-a",
    messageRevision: revisionA,
    date: "2024-07-18",
    ordinal: 0
  }]);
  assert.equal(validateRecordMigration(source, exact).report.status, "ready");

  const changed = historyMigrationInventoryFromReferences("v2", [{
    conversationId: "conversation-secret",
    messageId: "message-secret-a",
    messageRevision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    date: "2024-07-18",
    ordinal: 1
  }]);
  const blocked = validateRecordMigration(source, changed);
  assert.equal(blocked.report.status, "blocked");
  assert.ok(
    blocked.report.findings.some((finding) =>
      finding.code === "subject-revision-conflict")
  );
  assert.ok(
    blocked.report.findings.some((finding) =>
      finding.code === "subject-order-mismatch")
  );
}

function assertDeletionAuthorityCannotDisappearDuringCutover(): void {
  const tombstone = createConversationDeletionTombstone({
    conversationId: "deleted-conversation",
    mutationId: "delete-mutation",
    tombstoneId: "delete-tombstone",
    sourceGeneration: 2,
    sourceCommitId: "source-commit",
    sourceContentRevision:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    deletedAt: BASE_TIME
  });
  const source = conversationMigrationInventoryFromLegacySessions([], {
    deletionTombstones: [tombstone]
  });
  const missingTarget = conversationMigrationInventoryFromV2Commits([]);
  assert.ok(
    validateRecordMigration(source, missingTarget).report.findings.some(
      (finding) => finding.code === "subject-missing-in-target"
    )
  );
  const preservedTarget = conversationMigrationInventoryFromV2Commits(
    [],
    "v2",
    { deletionTombstones: [tombstone] }
  );
  assert.equal(
    validateRecordMigration(source, preservedTarget).report.status,
    "ready"
  );
}

function assertUntrustedProofCannotAuthorizeCutover(): void {
  const session = storedSession();
  const source = conversationMigrationInventoryFromLegacySessions([session]);
  const target = conversationMigrationInventoryFromV2Commits([
    projectStoredSessionToConversationCommitV2(session)
  ]);
  const result = validateRecordMigration(source, target);
  assert.ok(result.proof);
  const forged = {
    report: result.proof.report
  } as RecordMigrationValidationProof;
  assert.throws(
    () => assertRecordMigrationValidationProof(forged, {
      domain: "conversation",
      sourceFingerprint: source.fingerprint,
      targetFingerprint: target.fingerprint
    }),
    RecordMigrationValidationError
  );
}

function assertLegacyUnknownFieldsAndExternalOwnersFailClosed(): void {
  const unknownSession = storedSession() as StoredSession & {
    futureSessionField?: string;
  };
  unknownSession.futureSessionField = "must-not-be-dropped";
  assert.throws(
    () => projectStoredSessionToConversationCommitV2(unknownSession),
    /StoredSession contains unknown field futureSessionField/
  );

  const unknownMessage = storedSession();
  (unknownMessage.messages[0] as typeof unknownMessage.messages[number] & {
    futureMessageField?: string;
  }).futureMessageField = "must-not-be-dropped";
  assert.throws(
    () => projectStoredSessionToConversationCommitV2(unknownMessage),
    /ChatMessage contains unknown field futureMessageField/
  );

  const external = storedSession({ diagnostics: true });
  external.rollingSummary = {
    text: "current context summary",
    updatedAt: BASE_TIME + 2
  };
  external.tokenUsage = {
    total: {
      inputTokens: 10,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      totalTokens: 13
    },
    last: {
      inputTokens: 10,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      totalTokens: 13
    },
    modelContextWindow: 200_000
  };
  external.messages[0].phase = "executing";
  const edges = legacyExternalOwnerEdges([external]);
  assert.ok(
    edges.some((edge) => edge.kind === "settings-projection-owner")
  );
  assert.ok(edges.some((edge) => edge.kind === "run-record-owner"));
  assert.ok(edges.some((edge) => edge.kind === "native-execution-owner"));
  assert.equal(
    edges.every((edge) =>
      /^sha256:[a-f0-9]{64}$/.test(edge.ownerRef)
      && /^sha256:[a-f0-9]{64}$/.test(edge.resourceRef)),
    true,
    "external-owner ledgers must remain metadata-only"
  );
  const source = conversationMigrationInventoryFromLegacySessions([external]);
  const target = conversationMigrationInventoryFromV2Commits([
    projectStoredSessionToConversationCommitV2(external)
  ]);
  assert.equal(validateRecordMigration(source, target).report.status, "blocked");
}

async function assertDeletionTombstoneMigrationUsesDurableTargetAuthority():
Promise<void> {
  const parent = await mkdtemp(
    path.join(tmpdir(), "echoink-deletion-migration-")
  );
  const sourceStore = new FileConversationStore({
    rootPath: path.join(parent, "source")
  });
  const source = storedSession();
  await sourceStore.createPristineSession({
    id: source.id,
    title: source.title,
    kind: source.kind,
    revision: 1,
    generation: 1,
    contextId: "deleted-context",
    commitId: "deleted-commit",
    workspaceFingerprint: source.workspaceFingerprint,
    cwd: source.cwd,
    messages: [],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  });
  const durable = await sourceStore.readSession(source.id);
  assert.ok(durable);
  const tombstone = createConversationDeletionTombstone({
    conversationId: durable.id,
    mutationId: "deleted-mutation",
    tombstoneId: "deleted-tombstone",
    sourceGeneration: durable.generation!,
    sourceCommitId: durable.commitId!,
    sourceContentRevision: createConversationContentRevision(durable),
    deletedAt: BASE_TIME + 10
  });
  await sourceStore.commitConversationDeletionTombstone(tombstone, {
    expectedGeneration: durable.generation!,
    expectedCommitId: durable.commitId!,
    expectedContentRevision: createConversationContentRevision(durable)
  });

  const targetRoot = path.join(parent, "target");
  await mkdir(targetRoot);
  const targetStore = new FileConversationStoreV2({
    storageRootPath: targetRoot
  });
  const copied = await prepareConversationStoreV2Migration({
    sourceStore,
    targetStore
  });
  assert.equal(copied.createdDeletionTombstoneCount, 1);
  assert.equal(copied.reusedDeletionTombstoneCount, 0);
  assert.equal(copied.conflictingDeletionTombstoneCount, 0);
  assert.equal(copied.report.status, "ready");
  assert.deepEqual(
    (await targetStore.inspectMigrationSnapshot()).deletionTombstones,
    [tombstone]
  );
  const replayed = await prepareConversationStoreV2Migration({
    sourceStore,
    targetStore
  });
  assert.equal(replayed.createdDeletionTombstoneCount, 0);
  assert.equal(replayed.reusedDeletionTombstoneCount, 1);
  assert.equal(replayed.report.status, "ready");

  const conflictRoot = path.join(parent, "conflicting-target");
  await mkdir(conflictRoot);
  const conflictingTarget = new FileConversationStoreV2({
    storageRootPath: conflictRoot
  });
  await conflictingTarget.commitDeletionTombstone(
    createConversationDeletionTombstone({
      conversationId: durable.id,
      mutationId: "conflicting-deleted-mutation",
      tombstoneId: "conflicting-deleted-tombstone",
      sourceGeneration: durable.generation!,
      sourceCommitId: durable.commitId!,
      sourceContentRevision: createConversationContentRevision(durable),
      deletedAt: BASE_TIME + 11
    })
  );
  const conflict = await prepareConversationStoreV2Migration({
    sourceStore,
    targetStore: conflictingTarget
  });
  assert.equal(conflict.conflictingDeletionTombstoneCount, 1);
  assert.equal(conflict.report.status, "blocked");
  assert.ok(conflict.report.quarantine);
}

async function assertLegacyConversationMigrationSnapshotIsReadOnly():
Promise<void> {
  const parent = await mkdtemp(
    path.join(tmpdir(), "echoink-v1-migration-readonly-")
  );
  const absentRoot = path.join(parent, "absent");
  const absent = new FileConversationStore({ rootPath: absentRoot });
  assert.deepEqual(await absent.inspectMigrationSnapshot(), {
    sessions: [],
    deletionTombstones: []
  });
  assert.equal((await readdir(parent)).includes("absent"), false);

  const rootPath = path.join(parent, "conversations");
  const store = new FileConversationStore({ rootPath });
  const source = storedSession();
  await store.createPristineSession({
    id: source.id,
    title: source.title,
    kind: source.kind,
    revision: 1,
    generation: 1,
    contextId: "context-pristine",
    commitId: "commit-pristine",
    workspaceFingerprint: source.workspaceFingerprint,
    cwd: source.cwd,
    messages: [],
    createdAt: source.createdAt,
    updatedAt: source.createdAt
  });
  const pristine = await store.readSession(source.id);
  assert.ok(pristine);
  const session: StoredSession = {
    ...pristine,
    messages: source.messages,
    updatedAt: source.updatedAt
  };
  await store.upsertSession(session);
  assert.deepEqual(
    (await store.inspectMigrationSnapshot()).sessions,
    [session]
  );

  const copiedTargetRoot = path.join(parent, "copied-target");
  await mkdir(copiedTargetRoot);
  const copiedTarget = new FileConversationStoreV2({
    storageRootPath: copiedTargetRoot
  });
  const copied = await prepareConversationStoreV2Migration({
    sourceStore: store,
    targetStore: copiedTarget
  });
  assert.equal(copied.createdConversationCount, 1);
  assert.equal(copied.reusedConversationCount, 0);
  assert.equal(copied.conflictingConversationCount, 0);
  assert.equal(
    copied.report.status,
    "blocked",
    "copying Conversation bytes must not imply external-owner migration proof"
  );
  assert.ok(
    copied.report.findings.some((finding) =>
      finding.code === "owner-missing-in-target")
  );
  const targetExternalOwnerEdges = legacyExternalOwnerEdges([session]);
  const validatedCopy = await prepareConversationStoreV2Migration({
    sourceStore: store,
    targetStore: copiedTarget,
    targetExternalOwnerEdges
  });
  assert.equal(validatedCopy.createdConversationCount, 0);
  assert.equal(validatedCopy.reusedConversationCount, 1);
  assert.equal(
    validatedCopy.report.status,
    "ready",
    JSON.stringify(validatedCopy.report.findings)
  );
  const replayed = await prepareConversationStoreV2Migration({
    sourceStore: store,
    targetStore: copiedTarget,
    targetExternalOwnerEdges
  });
  assert.equal(replayed.createdConversationCount, 0);
  assert.equal(replayed.reusedConversationCount, 1);
  assert.equal(
    replayed.report.status,
    "ready",
    JSON.stringify(replayed.report.findings)
  );

  const targetStorageRoot = path.join(parent, "target");
  await mkdir(targetStorageRoot);
  const targetStore = new FileConversationStoreV2({
    storageRootPath: targetStorageRoot
  });
  await targetStore.commitConversation(
    projectStoredSessionToConversationCommitV2(session),
    {
      expectedRevision: null,
      expectedCommitId: null
    }
  );
  const exact = await inspectAndValidateConversationStoreMigration({
    sourceStore: store,
    targetStore,
    targetExternalOwnerEdges
  });
  assert.equal(exact.report.status, "ready");
  assert.ok(exact.proof);

  const conflictingTargetRoot = path.join(parent, "conflicting-target");
  await mkdir(conflictingTargetRoot);
  const conflictingTarget = new FileConversationStoreV2({
    storageRootPath: conflictingTargetRoot
  });
  const conflictSession = structuredClone(session);
  conflictSession.messages[0].text = "conflicting migrated body";
  await conflictingTarget.commitConversation(
    projectStoredSessionToConversationCommitV2(conflictSession),
    {
      expectedRevision: null,
      expectedCommitId: null
    }
  );
  const conflictRoot = path.join(parent, "conflict-quarantine");
  const preparedConflict = await prepareConversationStoreV2Migration({
    sourceStore: store,
    targetStore: conflictingTarget,
    targetExternalOwnerEdges,
    conflictQuarantineRootPath: conflictRoot
  });
  assert.equal(preparedConflict.conflictingConversationCount, 1);
  assert.equal(preparedConflict.conflictQuarantineReceipt?.created, true);
  const quarantineBytes = await readFile(
    preparedConflict.conflictQuarantineReceipt!.absolutePath,
    "utf8"
  );
  assert.doesNotMatch(quarantineBytes, /conversation-secret/);
  assert.doesNotMatch(quarantineBytes, /message-secret/);
  assert.doesNotMatch(quarantineBytes, /conflicting migrated body/);
  const replayedConflict = await prepareConversationStoreV2Migration({
    sourceStore: store,
    targetStore: conflictingTarget,
    targetExternalOwnerEdges,
    conflictQuarantineRootPath: conflictRoot
  });
  assert.equal(
    replayedConflict.conflictQuarantineReceipt?.created,
    false
  );
  const conflict = await inspectAndValidateConversationStoreMigration({
    sourceStore: store,
    targetStore: conflictingTarget,
    targetExternalOwnerEdges
  });
  assert.equal(conflict.report.status, "blocked");
  assert.ok(conflict.report.quarantine);
  assert.equal(conflict.proof, null);

  const indexPath = path.join(rootPath, "index.json");
  await writeFile(indexPath, `${JSON.stringify({
    version: 1,
    updatedAt: BASE_TIME + 3,
    sessions: []
  })}\n`, "utf8");
  const corruptBytes = await readFile(indexPath, "utf8");
  await assert.rejects(
    () => store.inspectMigrationSnapshot(),
    /index does not match committed sessions/
  );
  assert.equal(await readFile(indexPath, "utf8"), corruptBytes);
}

function storedSession(
  options: { diagnostics?: boolean } = {}
): StoredSession {
  return {
    id: "conversation-secret",
    title: "Migration fixture",
    kind: "chat",
    revision: 3,
    generation: 3,
    contextId: "context-current",
    workspaceFingerprint:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    cwd: "/vault",
    messages: [{
      id: "message-secret-a",
      role: "user",
      text: "original secret body",
      rawRef: "raw/secret-a.md",
      rawSize: 128,
      rawLines: 4,
      rawTruncatedForPreview: true,
      createdAt: BASE_TIME,
      ...(options.diagnostics
        ? {
          backendId: "codex-cli",
          nativeLeaseId: "native-secret",
          runId: "run-secret",
          processInput: "diagnostic secret"
        }
        : {})
    }, {
      id: "message-secret-b",
      role: "assistant",
      text: "assistant answer",
      itemType: "chat-message",
      title: "Visible answer",
      status: "completed",
      createdAt: BASE_TIME + 1,
      completedAt: BASE_TIME + 2
    }],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 2
  };
}

if (process.env.ECHOINK_RUN_RECORD_MIGRATION_VALIDATOR_TEST === "1") {
  runHarnessV2RecordMigrationValidatorTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
