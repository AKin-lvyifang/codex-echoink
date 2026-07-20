import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ConversationV2ContractError,
  finalizeConversationCommitV2,
  validateConversationCommitV2,
  validateConversationMessageV2,
  validateConversationMetadataV2,
  validateConversationPayloadV2,
  validateConversationPresentationV2,
  validateConversationSnapshotV2,
  type ConversationCommitV2,
  type ConversationMetadataV2,
  type MessageV2,
  type Presentation,
  type SnapshotV2
} from "../../harness/contracts/conversation-v2";
import {
  createConversationDeletionTombstone
} from "../../harness/conversation/conversation-store";
import {
  FileConversationStoreV2,
  ConversationStoreV2Error,
  ConversationStoreV2ConflictError,
  ConversationStoreV2SimulatedCrash,
  conversationStoreV2Root,
  type ConversationStoreV2FaultPoint
} from "../../harness/conversation/conversation-store-v2";
import {
  FileConversationStoreManifest,
  ConversationStoreManifestError,
  advanceConversationStoreManifestToActive,
  advanceConversationStoreManifestToValidated,
  conversationStoreManifestRoot,
  createCopyingConversationStoreManifest,
  finalizeConversationStoreManifest,
  resolveConversationStoreSelection
} from "../../harness/conversation/store-manifest";
import {
  projectConversationShellV2,
  validateConversationShellV2
} from "../../harness/conversation/conversation-shell";
import {
  finalizeRecordMigrationInventory,
  validateRecordMigration,
  type RecordMigrationValidationProof
} from "../../harness/lifecycle/record-migration-validator";

const BASE_TIME = 1_721_260_800_000;
const SOURCE_INVENTORY = finalizeRecordMigrationInventory({
  domain: "conversation",
  projection: "conversation-portable-v1",
  storeVersion: "v1",
  subjects: []
});
const TARGET_INVENTORY = finalizeRecordMigrationInventory({
  domain: "conversation",
  projection: "conversation-portable-v1",
  storeVersion: "v2",
  subjects: []
});
const SOURCE_FINGERPRINT = SOURCE_INVENTORY.fingerprint;
const TARGET_FINGERPRINT = TARGET_INVENTORY.fingerprint;
const WORKSPACE_FINGERPRINT = `sha256:${"4".repeat(64)}`;

export async function runHarnessV2ConversationStoreV2Tests(): Promise<void> {
  assertStrictConversationV2Contracts();
  assertContextSegmentsAndAttemptLineageFailClosed();
  assertSnapshotMustExactlyDescribeCurrentContext();
  assertConversationShellUsesAnExplicitAllowlist();
  await assertManifestDefaultsToV1AndRequiresOrderedCutover();
  await assertManifestActiveCutoverRecoversAfterFenceCrash();
  await assertManifestCasAllowsOnlyOneSameRevisionWinner();
  await assertManifestChainFailsClosedOnFutureAndUnknownEntries();
  await assertContentAddressedCommitAndIndexRoundTrip();
  await assertMigrationSnapshotIsStrictlyReadOnly();
  await assertConversationStoreRejectsMessageRewriteAndTailTruncation();
  await assertConversationStoreCrashWindows();
  await assertConversationStoreCasAllowsOnlyOneSameRevisionWinner();
  await assertConversationStoreRejectsSymlinksUnknownEntriesAndPathEscape();
}

function assertStrictConversationV2Contracts(): void {
  const commit = conversationCommit({
    revision: 0,
    commitId: "commit-0"
  });
  assert.deepEqual(validateConversationPresentationV2(
    commit.payload.messages[0].presentation
  ), {
    schemaVersion: 1,
    itemType: "chat-message",
    title: "Visible message",
    status: "completed",
    details: "Product-visible details"
  });
  assert.deepEqual(
    validateConversationMessageV2(commit.payload.messages[0]),
    commit.payload.messages[0]
  );
  assert.deepEqual(
    validateConversationSnapshotV2(commit.payload.snapshot),
    commit.payload.snapshot
  );
  assert.deepEqual(validateConversationPayloadV2(commit.payload), commit.payload);
  assert.deepEqual(validateConversationMetadataV2(commit.metadata), commit.metadata);
  assert.deepEqual(validateConversationCommitV2(commit), commit);
  assert.match(commit.metadata.payloadDigest, /^sha256:[a-f0-9]{64}$/);

  assertContractCode(
    () => validateConversationMetadataV2({
      ...commit.metadata,
      schemaVersion: 3
    }),
    "future-schema"
  );
  assertContractCode(
    () => validateConversationPayloadV2({
      ...commit.payload,
      backendBindings: {}
    }),
    "unexpected-field"
  );
  assertContractCode(
    () => validateConversationPresentationV2({
      ...commit.payload.messages[0].presentation,
      backendId: "codex"
    }),
    "unexpected-field"
  );
  assertContractCode(
    () => validateConversationPresentationV2({
      ...commit.payload.messages[0].presentation,
      schemaVersion: 2
    }),
    "future-schema"
  );
  assertContractCode(
    () => validateConversationPresentationV2({
      schemaVersion: 1,
      knowledgeBaseUi: {
        kind: "maintain-report",
        backend: "codex-cli"
      }
    }),
    "forbidden-field"
  );
  for (const forbiddenKey of [
    "nativeThreadId",
    "attemptCount",
    "eventLog",
    "workflowRunId",
    "processStdout"
  ]) {
    assertContractCode(
      () => validateConversationPresentationV2({
        schemaVersion: 1,
        knowledgeBaseUi: {
          kind: "maintain-report",
          [forbiddenKey]: "must-not-enter-conversation"
        }
      }),
      "forbidden-field"
    );
  }
  assertContractCode(
    () => validateConversationMessageV2({
      ...commit.payload.messages[0],
      backendId: "codex"
    }),
    "unexpected-field"
  );
  assertContractCode(
    () => validateConversationCommitV2({
      metadata: {
        ...commit.metadata,
        payloadDigest: `sha256:${"0".repeat(64)}`
      },
      payload: commit.payload
    }),
    "digest-mismatch"
  );
}

function assertContextSegmentsAndAttemptLineageFailClosed(): void {
  const commit = conversationCommit();
  const firstMessage = commit.payload.messages[0];

  assertContractCode(
    () => validateConversationMessageV2(withoutKey(firstMessage, "contextId")),
    "missing-field"
  );

  assert.doesNotThrow(() => finalizeConversationCommitV2({
    conversationId: "conversation-v2",
    revision: 0,
    commitId: "workflow-scoped-attempts",
    title: "Conversation V2",
    kind: "chat",
    currentContext: currentContext("context-b", 2),
    messages: [
      {
        ...message("message-workflow-a", "context-a", 1),
        workflowRunId: "workflow-a",
        attemptId: "attempt-shared"
      },
      {
        ...message("message-workflow-b", "context-b", 2),
        workflowRunId: "workflow-b",
        attemptId: "attempt-shared"
      }
    ],
    snapshot: snapshot("context-b", ["message-workflow-b"], 2),
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 2
  }));
  assertContractCode(
    () => validateConversationMessageV2(withoutKey({
      ...firstMessage,
      attemptId: "attempt-without-workflow"
    }, "workflowRunId")),
    "lineage-mismatch"
  );
  assertContractCode(
    () => validateConversationMessageV2({
      ...firstMessage,
      raw: {
        ...firstMessage.raw,
        backendId: "not-product-state"
      }
    }),
    "unexpected-field"
  );

  const discontinuousMessages: MessageV2[] = [
    message("message-a", "context-a", 1),
    message("message-b", "context-b", 2),
    message("message-c", "context-a", 3)
  ];
  assertContractCode(
    () => finalizeConversationCommitV2({
      conversationId: "conversation-v2",
      revision: 0,
      commitId: "discontinuous",
      title: "Conversation V2",
      kind: "chat",
      currentContext: currentContext("context-a", 3),
      messages: discontinuousMessages,
      snapshot: snapshot("context-a", ["message-c"], 3),
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 3
    }),
    "context-sequence"
  );

  assertContractCode(
    () => finalizeConversationCommitV2({
      conversationId: "conversation-v2",
      revision: 0,
      commitId: "wrong-current-context",
      title: "Conversation V2",
      kind: "chat",
      currentContext: currentContext("context-a", 1),
      messages: [
        message("message-a", "context-a", 1),
        message("message-b", "context-b", 2)
      ],
      snapshot: snapshot("context-a", ["message-a"], 1),
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 2
    }),
    "context-sequence"
  );
}

function assertSnapshotMustExactlyDescribeCurrentContext(): void {
  const messages = [
    message("message-a", "context-a", 1),
    message("message-b", "context-b", 2),
    message("message-c", "context-b", 3)
  ];
  const input = {
    conversationId: "conversation-v2",
    revision: 0,
    commitId: "snapshot-consistency",
    title: "Conversation V2",
    kind: "chat" as const,
    currentContext: currentContext("context-b", 2),
    messages,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 3
  };
  assert.doesNotThrow(() => finalizeConversationCommitV2({
    ...input,
    snapshot: snapshot("context-b", ["message-b", "message-c"], 2)
  }));

  const mismatches: SnapshotV2[] = [
    snapshot("context-a", ["message-a"], 1),
    {
      ...snapshot("context-b", ["message-b", "message-c"], 3)
    },
    {
      ...snapshot("context-b", ["message-b", "message-c"], 2),
      sourceMessageCount: 1
    },
    {
      ...snapshot("context-b", ["message-b", "message-c"], 2),
      summarizedFromMessageId: "message-c"
    },
    {
      ...snapshot("context-b", ["message-b", "message-c"], 2),
      summarizedThroughMessageId: "message-b"
    }
  ];
  for (const candidate of mismatches) {
    assertContractCode(
      () => finalizeConversationCommitV2({
        ...input,
        snapshot: candidate
      }),
      "snapshot-mismatch"
    );
  }
}

function assertConversationShellUsesAnExplicitAllowlist(): void {
  const commit = conversationCommit();
  const tainted = {
    ...commit,
    backend: "codex",
    backendBindings: { codex: { id: "native-secret" } },
    rollingSummary: "secret summary",
    rawText: "secret raw body"
  } as ConversationCommitV2;
  const shell = projectConversationShellV2(tainted);
  assert.deepEqual(Object.keys(shell).sort(), [
    "conversationId",
    "createdAt",
    "kind",
    "title",
    "updatedAt"
  ]);
  assert.deepEqual(validateConversationShellV2(shell), shell);
  const serialized = JSON.stringify(shell);
  for (const forbidden of [
    "backend",
    "binding",
    "snapshot",
    "summary",
    "raw",
    "secret",
    "messages",
    "payloadDigest",
    "commitId",
    "contextId",
    "revision",
    "messageCount"
  ]) {
    assert.equal(
      serialized.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `Conversation shell leaked forbidden token: ${forbidden}`
    );
  }
  assert.throws(
    () => validateConversationShellV2({
      ...shell,
      snapshot: commit.payload.snapshot
    }),
    ConversationV2ContractError
  );
}

async function assertManifestDefaultsToV1AndRequiresOrderedCutover(): Promise<void> {
  const storageRootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversation-manifest-"));
  const residualRoot = conversationStoreV2Root(storageRootPath);
  await mkdir(residualRoot, { recursive: true });
  await writeFile(path.join(residualRoot, "residual.json"), "{}\n", "utf8");

  assert.deepEqual(await resolveConversationStoreSelection(storageRootPath), {
    activeStore: "v1",
    reason: "manifest-absent",
    manifest: null
  });

  const manifestStore = new FileConversationStoreManifest({ storageRootPath });
  const copying = createCopyingConversationStoreManifest({
    commitId: "manifest-copying",
    sourceFingerprint: SOURCE_FINGERPRINT,
    createdAt: BASE_TIME
  });
  await manifestStore.compareAndSwap(copying, {
    expectedRevision: null,
    expectedCommitId: null
  });
  assert.equal(
    (await resolveConversationStoreSelection(storageRootPath)).activeStore,
    "v1",
    "copying must keep V1 active"
  );

  const { digest: _copyingDigest, ...copyingWithoutDigest } = copying;
  const directActive = finalizeConversationStoreManifest({
    ...copyingWithoutDigest,
    migrationState: "active",
    activeStore: "v2",
    targetFingerprint: TARGET_FINGERPRINT,
    activatedAt: BASE_TIME + 1,
    revision: 1,
    commitId: "manifest-skip-validated",
    updatedAt: BASE_TIME + 1
  });
  await assert.rejects(
    () => manifestStore.compareAndSwap(directActive, {
      expectedRevision: copying.revision,
      expectedCommitId: copying.commitId
    }),
    (error: unknown) => (
      error instanceof ConversationStoreManifestError
      && error.code === "invalid-transition"
    )
  );

  const trustedProof = manifestValidationProof();
  assert.throws(
    () => advanceConversationStoreManifestToValidated(copying, {
      commitId: "manifest-forged-validation",
      proof: { report: trustedProof.report },
      updatedAt: BASE_TIME + 1
    }),
    /not trusted/
  );
  const validated = advanceConversationStoreManifestToValidated(copying, {
    commitId: "manifest-validated",
    proof: trustedProof,
    updatedAt: BASE_TIME + 1
  });
  await manifestStore.compareAndSwap(validated, {
    expectedRevision: copying.revision,
    expectedCommitId: copying.commitId
  });
  assert.equal(
    (await resolveConversationStoreSelection(storageRootPath)).activeStore,
    "v1",
    "validated must keep V1 active until the atomic cutover"
  );

  const active = advanceConversationStoreManifestToActive(validated, {
    commitId: "manifest-active",
    activatedAt: BASE_TIME + 2
  });
  await manifestStore.compareAndSwap(active, {
    expectedRevision: validated.revision,
    expectedCommitId: validated.commitId
  });
  assert.equal(
    (await resolveConversationStoreSelection(storageRootPath)).activeStore,
    "v2"
  );

  const { digest: _activeDigest, ...activeWithoutDigest } = active;
  const directRollback = finalizeConversationStoreManifest({
    ...activeWithoutDigest,
    migrationState: "validated",
    activeStore: "v1",
    activatedAt: null,
    revision: active.revision + 1,
    commitId: "manifest-direct-rollback",
    updatedAt: active.updatedAt + 1
  });
  await assert.rejects(
    () => manifestStore.compareAndSwap(directRollback, {
      expectedRevision: active.revision,
      expectedCommitId: active.commitId
    }),
    (error: unknown) => (
      error instanceof ConversationStoreManifestError
      && error.code === "rollback-requires-export"
    )
  );

  await unlink(path.join(
    conversationStoreManifestRoot(storageRootPath),
    "entry-0000000000000002.json"
  ));
  const recoverable = await resolveConversationStoreSelection(storageRootPath);
  assert.equal(recoverable.activeStore, "v1");
  assert.equal(recoverable.reason, "active-cutover-pending");
  assert.equal(
    (await manifestStore.recoverPendingActiveCutover())?.digest,
    active.digest
  );

}

async function assertManifestCasAllowsOnlyOneSameRevisionWinner(): Promise<void> {
  const storageRootPath = await mkdtemp(path.join(tmpdir(), "echoink-manifest-cas-"));
  const store = new FileConversationStoreManifest({ storageRootPath });
  const copying = createCopyingConversationStoreManifest({
    commitId: "copying",
    sourceFingerprint: SOURCE_FINGERPRINT,
    createdAt: BASE_TIME
  });
  await store.compareAndSwap(copying, {
    expectedRevision: null,
    expectedCommitId: null
  });
  const left = advanceConversationStoreManifestToValidated(copying, {
    commitId: "validated-left",
    proof: manifestValidationProof(),
    updatedAt: BASE_TIME + 1
  });
  const right = advanceConversationStoreManifestToValidated(copying, {
    commitId: "validated-right",
    proof: manifestValidationProof(),
    updatedAt: BASE_TIME + 1
  });
  const results = await Promise.allSettled([
    store.compareAndSwap(left, {
      expectedRevision: copying.revision,
      expectedCommitId: copying.commitId
    }),
    store.compareAndSwap(right, {
      expectedRevision: copying.revision,
      expectedCommitId: copying.commitId
    })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const current = await store.read();
  assert.ok(current);
  assert.ok(
    current.commitId === left.commitId || current.commitId === right.commitId
  );
}

async function assertManifestActiveCutoverRecoversAfterFenceCrash():
Promise<void> {
  const storageRootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-manifest-active-recovery-")
  );
  const proof = manifestValidationProof();
  const setup = new FileConversationStoreManifest({ storageRootPath });
  const copying = createCopyingConversationStoreManifest({
    commitId: "active-recovery-copying",
    sourceFingerprint: SOURCE_FINGERPRINT,
    createdAt: BASE_TIME
  });
  await setup.compareAndSwap(copying, {
    expectedRevision: null,
    expectedCommitId: null
  });
  const validated = advanceConversationStoreManifestToValidated(copying, {
    commitId: "active-recovery-validated",
    proof,
    updatedAt: BASE_TIME + 1
  });
  await setup.compareAndSwap(validated, {
    expectedRevision: copying.revision,
    expectedCommitId: copying.commitId
  });
  const active = advanceConversationStoreManifestToActive(validated, {
    commitId: "active-recovery-active",
    activatedAt: BASE_TIME + 2
  });

  let crashed = false;
  const crashing = new FileConversationStoreManifest({
    storageRootPath,
    faultInjector(point) {
      if (point === "after-active-fence" && !crashed) {
        crashed = true;
        throw new Error("simulated crash after active fence");
      }
    }
  });
  await assert.rejects(
    () => crashing.compareAndSwap(active, {
      expectedRevision: validated.revision,
      expectedCommitId: validated.commitId
    }),
    /simulated crash/
  );
  const pending = await resolveConversationStoreSelection(storageRootPath);
  assert.equal(pending.activeStore, "v1");
  assert.equal(pending.reason, "active-cutover-pending");
  assert.equal(pending.manifest?.migrationState, "validated");

  const recovered = await setup.recoverPendingActiveCutover();
  assert.equal(recovered?.digest, active.digest);
  const selected = await resolveConversationStoreSelection(storageRootPath);
  assert.equal(selected.activeStore, "v2");
  assert.equal(selected.reason, "manifest-active");
  assert.deepEqual(await setup.recoverPendingActiveCutover(), recovered);
}

async function assertManifestChainFailsClosedOnFutureAndUnknownEntries(): Promise<void> {
  const futureRoot = await mkdtemp(path.join(tmpdir(), "echoink-manifest-future-"));
  const futureChainRoot = conversationStoreManifestRoot(futureRoot);
  await mkdir(futureChainRoot, { recursive: true });
  const copying = createCopyingConversationStoreManifest({
    commitId: "future-source",
    sourceFingerprint: SOURCE_FINGERPRINT,
    createdAt: BASE_TIME
  });
  await writeFile(
    path.join(futureChainRoot, "entry-0000000000000000.json"),
    `${JSON.stringify({ ...copying, schemaVersion: 2 })}\n`,
    "utf8"
  );
  await assert.rejects(
    () => resolveConversationStoreSelection(futureRoot),
    (error: unknown) => (
      error instanceof ConversationStoreManifestError
      && error.code === "future-schema"
    )
  );

  const unknownRoot = await mkdtemp(path.join(tmpdir(), "echoink-manifest-unknown-"));
  const unknownStore = new FileConversationStoreManifest({
    storageRootPath: unknownRoot
  });
  const initial = createCopyingConversationStoreManifest({
    commitId: "unknown-source",
    sourceFingerprint: SOURCE_FINGERPRINT,
    createdAt: BASE_TIME
  });
  await unknownStore.compareAndSwap(initial, {
    expectedRevision: null,
    expectedCommitId: null
  });
  await writeFile(
    path.join(conversationStoreManifestRoot(unknownRoot), "future-entry.json"),
    "{}\n",
    "utf8"
  );
  await assert.rejects(
    () => unknownStore.read(),
    (error: unknown) => (
      error instanceof ConversationStoreManifestError
      && error.code === "unsafe-entry"
    )
  );
}

async function assertContentAddressedCommitAndIndexRoundTrip(): Promise<void> {
  const storageRootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversation-v2-"));
  const store = new FileConversationStoreV2({ storageRootPath });
  const initial = conversationCommit({
    revision: 0,
    commitId: "conversation-commit-0"
  });
  await store.commitConversation(initial, {
    expectedRevision: null,
    expectedCommitId: null
  });
  assert.deepEqual(await store.readConversation("conversation-v2"), initial);
  assert.deepEqual(await store.listConversationShells(), [
    projectConversationShellV2(initial)
  ]);

  const payloadEntries = await readdir(
    path.join(conversationStoreV2Root(storageRootPath), "payloads")
  );
  assert.deepEqual(payloadEntries, [
    `${initial.metadata.payloadDigest.slice("sha256:".length)}.json`
  ]);
  const payloadBytes = await readFile(path.join(
    conversationStoreV2Root(storageRootPath),
    "payloads",
    payloadEntries[0]
  ), "utf8");
  assert.deepEqual(JSON.parse(payloadBytes), initial.payload);

  const updated = conversationCommit({
    revision: 1,
    commitId: "conversation-commit-1",
    title: "Renamed Conversation V2",
    previousMetadata: initial.metadata
  });
  await store.commitConversation(updated, {
    expectedRevision: initial.metadata.revision,
    expectedCommitId: initial.metadata.commitId
  });
  assert.deepEqual(await store.readConversation("conversation-v2"), updated);
  assert.equal(
    (await readdir(path.join(conversationStoreV2Root(storageRootPath), "payloads"))).length,
    1,
    "a metadata-only rename must reuse the same immutable content-addressed payload"
  );
}

async function assertMigrationSnapshotIsStrictlyReadOnly(): Promise<void> {
  const absentRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-v2-readonly-absent-")
  );
  const absentStore = new FileConversationStoreV2({
    rootPath: path.join(absentRoot, "does-not-exist")
  });
  assert.deepEqual(await absentStore.inspectMigrationSnapshot(), {
    commits: [],
    deletionTombstones: []
  });
  assert.equal(
    (await readdir(absentRoot)).includes("does-not-exist"),
    false,
    "read-only migration inspection must not initialize an absent root"
  );

  const storageRootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-v2-readonly-")
  );
  const store = new FileConversationStoreV2({ storageRootPath });
  const commit = conversationCommit();
  await store.commitConversation(commit, {
    expectedRevision: null,
    expectedCommitId: null
  });
  const tombstone = createConversationDeletionTombstone({
    conversationId: "deleted-conversation-v2",
    mutationId: "deleted-conversation-v2-mutation",
    tombstoneId: "deleted-conversation-v2-tombstone",
    sourceGeneration: 1,
    sourceCommitId: "deleted-conversation-v2-commit",
    sourceContentRevision:
      `sha256:${"8".repeat(64)}`,
    deletedAt: BASE_TIME + 10
  });
  assert.deepEqual(
    await store.commitDeletionTombstone(tombstone),
    tombstone
  );
  assert.deepEqual(
    await store.commitDeletionTombstone(tombstone),
    tombstone,
    "replaying the exact tombstone must be idempotent"
  );
  assert.deepEqual(
    await store.readDeletionTombstone(tombstone.conversationId),
    tombstone
  );
  assert.deepEqual(await store.inspectMigrationSnapshot(), {
    commits: [commit],
    deletionTombstones: [tombstone]
  });
  await assert.rejects(
    () => store.commitDeletionTombstone(
      createConversationDeletionTombstone({
        conversationId: commit.metadata.conversationId,
        mutationId: "conflicting-live-mutation",
        tombstoneId: "conflicting-live-tombstone",
        sourceGeneration: 1,
        sourceCommitId: "conflicting-live-commit",
        sourceContentRevision:
          `sha256:${"9".repeat(64)}`,
        deletedAt: BASE_TIME + 11
      })
    ),
    ConversationStoreV2ConflictError
  );

  const raceRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-v2-conversation-tombstone-race-")
  );
  const raceStore = new FileConversationStoreV2({
    storageRootPath: raceRoot
  });
  const raceConversation = conversationCommit({
    conversationId: "conversation-tombstone-race"
  });
  const raceTombstone = createConversationDeletionTombstone({
    conversationId: raceConversation.metadata.conversationId,
    mutationId: "conversation-tombstone-race-mutation",
    tombstoneId: "conversation-tombstone-race-tombstone",
    sourceGeneration: 1,
    sourceCommitId: "conversation-tombstone-race-source",
    sourceContentRevision: `sha256:${"7".repeat(64)}`,
    deletedAt: BASE_TIME + 12
  });
  const raceResults = await Promise.allSettled([
    raceStore.commitConversation(raceConversation, {
      expectedRevision: null,
      expectedCommitId: null
    }),
    raceStore.commitDeletionTombstone(raceTombstone)
  ]);
  assert.equal(
    raceResults.filter((result) => result.status === "fulfilled").length,
    1,
    "an active Conversation and its tombstone must have exactly one winner"
  );
  assert.ok(
    raceResults.find((result) => result.status === "rejected")
      ?.reason instanceof ConversationStoreV2ConflictError
  );
  const raceSnapshot = await raceStore.inspectMigrationSnapshot();
  assert.equal(
    raceSnapshot.commits.length
      + raceSnapshot.deletionTombstones.length,
    1
  );

  const root = conversationStoreV2Root(storageRootPath);
  const indexPath = path.join(root, "index.json");
  await writeFile(indexPath, "{}\n", "utf8");
  const corruptIndexBytes = await readFile(indexPath, "utf8");
  await assert.rejects(
    () => store.inspectMigrationSnapshot(),
    ConversationStoreV2Error
  );
  assert.equal(
    await readFile(indexPath, "utf8"),
    corruptIndexBytes,
    "migration inspection must not repair a corrupt index"
  );
}

async function assertConversationStoreRejectsMessageRewriteAndTailTruncation(): Promise<void> {
  const storageRootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversation-v2-lineage-"));
  const store = new FileConversationStoreV2({ storageRootPath });
  const initial = conversationCommit({ commitId: "lineage-initial" });
  await store.commitConversation(initial, {
    expectedRevision: null,
    expectedCommitId: null
  });
  const rewrittenMessages = initial.payload.messages.map((item, index) => (
    index === 0 ? { ...item, text: "silently rewritten" } : item
  ));
  const rewritten = finalizeConversationCommitV2({
    conversationId: initial.metadata.conversationId,
    revision: 1,
    commitId: "lineage-rewrite",
    previousMetadata: initial.metadata,
    title: initial.metadata.title,
    kind: initial.metadata.kind,
    currentContext: initial.metadata.currentContext,
    messages: rewrittenMessages,
    snapshot: initial.payload.snapshot,
    createdAt: initial.metadata.createdAt,
    updatedAt: initial.metadata.updatedAt + 1
  });
  await assert.rejects(
    () => store.commitConversation(rewritten, {
      expectedRevision: initial.metadata.revision,
      expectedCommitId: initial.metadata.commitId
    }),
    ConversationStoreV2ConflictError
  );
  const deleted = finalizeConversationCommitV2({
    conversationId: initial.metadata.conversationId,
    revision: 1,
    commitId: "lineage-delete",
    previousMetadata: initial.metadata,
    title: initial.metadata.title,
    kind: initial.metadata.kind,
    currentContext: initial.metadata.currentContext,
    messages: initial.payload.messages.slice(1),
    snapshot: snapshot("context-b", ["message-b"], 2),
    createdAt: initial.metadata.createdAt,
    updatedAt: initial.metadata.updatedAt + 1
  });
  await assert.rejects(
    () => store.commitConversation(deleted, {
      expectedRevision: initial.metadata.revision,
      expectedCommitId: initial.metadata.commitId
    }),
    ConversationStoreV2ConflictError
  );

  const valid = finalizeConversationCommitV2({
    conversationId: initial.metadata.conversationId,
    revision: 1,
    commitId: "lineage-valid",
    previousMetadata: initial.metadata,
    title: "lineage valid",
    kind: initial.metadata.kind,
    currentContext: initial.metadata.currentContext,
    messages: [
      ...initial.payload.messages,
      message("message-c", "context-b", 3)
    ],
    snapshot: snapshot("context-b", ["message-b", "message-c"], 2),
    createdAt: initial.metadata.createdAt,
    updatedAt: initial.metadata.updatedAt + 1
  });
  await store.commitConversation(valid, {
    expectedRevision: initial.metadata.revision,
    expectedCommitId: initial.metadata.commitId
  });
  const token = `conversation-${createHash("sha256")
    .update(initial.metadata.conversationId, "utf8")
    .digest("hex")}`;
  await unlink(path.join(
    conversationStoreV2Root(storageRootPath),
    "conversations",
    token,
    "metadata",
    "entry-0000000000000001.json"
  ));
  await assert.rejects(
    () => store.readConversation(initial.metadata.conversationId),
    /head|chain|metadata/i
  );
}

async function assertConversationStoreCrashWindows(): Promise<void> {
  const beforeMarkerPoints: ConversationStoreV2FaultPoint[] = [
    "before-payload",
    "after-payload",
    "before-metadata-marker",
    "after-metadata-publish"
  ];
  for (const point of beforeMarkerPoints) {
    const fixture = await crashFixture(point);
    assert.equal(
      await fixture.cleanStore.readConversation("conversation-v2"),
      null,
      `${point} must not publish a Conversation without metadata commit marker`
    );
    assert.deepEqual(
      await fixture.cleanStore.listConversationShells(),
      [],
      `${point} must not expose an index row`
    );
  }

  const orphanFixture = await crashFixture("after-metadata-publish");
  const differentWinner = conversationCommit({
    revision: orphanFixture.commit.metadata.revision,
    commitId: "different-orphan-winner"
  });
  await assert.rejects(
    () => orphanFixture.cleanStore.commitConversation(differentWinner, {
      expectedRevision: null,
      expectedCommitId: null
    }),
    ConversationStoreV2ConflictError,
    "a different candidate cannot replace an unpublished metadata orphan"
  );
  assert.deepEqual(
    await orphanFixture.cleanStore.commitConversation(orphanFixture.commit, {
      expectedRevision: null,
      expectedCommitId: null
    }),
    orphanFixture.commit,
    "an identical retry must reuse the metadata orphan and advance the head"
  );

  const committedPoints: ConversationStoreV2FaultPoint[] = [
    "after-metadata-marker",
    "before-index",
    "after-index"
  ];
  for (const point of committedPoints) {
    const fixture = await crashFixture(point);
    assert.deepEqual(
      await fixture.cleanStore.readConversation("conversation-v2"),
      fixture.commit,
      `${point} must preserve the metadata-marked commit`
    );
    assert.deepEqual(
      await fixture.cleanStore.listConversationShells(),
      [projectConversationShellV2(fixture.commit)],
      `${point} must allow deterministic index repair from metadata`
    );
  }
}

async function assertConversationStoreCasAllowsOnlyOneSameRevisionWinner(): Promise<void> {
  const storageRootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversation-v2-cas-"));
  const store = new FileConversationStoreV2({ storageRootPath });
  const initial = conversationCommit({
    revision: 0,
    commitId: "conversation-initial"
  });
  await store.commitConversation(initial, {
    expectedRevision: null,
    expectedCommitId: null
  });
  const left = conversationCommit({
    revision: 1,
    commitId: "conversation-left",
    title: "Left winner",
    previousMetadata: initial.metadata
  });
  const right = conversationCommit({
    revision: 1,
    commitId: "conversation-right",
    title: "Right winner",
    previousMetadata: initial.metadata
  });
  const results = await Promise.allSettled([
    store.commitConversation(left, {
      expectedRevision: initial.metadata.revision,
      expectedCommitId: initial.metadata.commitId
    }),
    store.commitConversation(right, {
      expectedRevision: initial.metadata.revision,
      expectedCommitId: initial.metadata.commitId
    })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(
    rejection?.status === "rejected"
    && rejection.reason instanceof ConversationStoreV2ConflictError
  );
  const durable = await store.readConversation("conversation-v2");
  assert.ok(durable);
  assert.ok(
    durable.metadata.commitId === left.metadata.commitId
    || durable.metadata.commitId === right.metadata.commitId
  );
  assert.deepEqual(await store.listConversationShells(), [
    projectConversationShellV2(durable)
  ]);
}

async function assertConversationStoreRejectsSymlinksUnknownEntriesAndPathEscape(): Promise<void> {
  const symlinkStorageRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-conversation-v2-symlink-")
  );
  const outsideRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-conversation-v2-outside-")
  );
  const v2Root = conversationStoreV2Root(symlinkStorageRoot);
  await mkdir(v2Root, { recursive: true });
  await symlink(outsideRoot, path.join(v2Root, "payloads"), "dir");
  const symlinkStore = new FileConversationStoreV2({
    storageRootPath: symlinkStorageRoot
  });
  await assert.rejects(
    () => symlinkStore.commitConversation(conversationCommit(), {
      expectedRevision: null,
      expectedCommitId: null
    }),
    /symlink|unsafe|安全/i
  );
  assert.deepEqual(
    await readdir(outsideRoot),
    [],
    "payload directory symlink must never write outside the V2 root"
  );

  const unknownStorageRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-conversation-v2-unknown-")
  );
  const unknownStore = new FileConversationStoreV2({
    storageRootPath: unknownStorageRoot
  });
  await unknownStore.commitConversation(conversationCommit(), {
    expectedRevision: null,
    expectedCommitId: null
  });
  await writeFile(
    path.join(conversationStoreV2Root(unknownStorageRoot), "conversations", "unknown.txt"),
    "{}\n",
    "utf8"
  );
  await assert.rejects(
    () => unknownStore.listConversationShells(),
    /unknown|unsafe|未知|安全/i
  );

  const pathStorageRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-conversation-v2-path-")
  );
  const pathStore = new FileConversationStoreV2({
    storageRootPath: pathStorageRoot
  });
  const escapedId = "../../must-not-escape";
  const escapedCommit = finalizeConversationCommitV2({
    conversationId: escapedId,
    revision: 0,
    commitId: "path-safe",
    title: "Conversation V2",
    kind: "chat",
    currentContext: currentContext("context-safe", 1),
    messages: [],
    snapshot: {
      ...snapshot("context-safe", [], 1),
      conversationId: escapedId
    },
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME
  });
  await pathStore.commitConversation(escapedCommit, {
    expectedRevision: null,
    expectedCommitId: null
  });
  assert.deepEqual(await pathStore.readConversation(escapedId), escapedCommit);
  assert.equal(
    await readFile(path.join(pathStorageRoot, "must-not-escape"), "utf8")
      .then(() => true, () => false),
    false,
    "opaque Conversation IDs must never become filesystem paths"
  );

  const committedRoot = conversationStoreV2Root(pathStorageRoot);
  const conversationEntries = await readdir(path.join(committedRoot, "conversations"));
  assert.equal(conversationEntries.length, 1);
  assert.match(conversationEntries[0], /^conversation-[a-f0-9]{64}$/);

  const metadataPath = path.join(
    committedRoot,
    "conversations",
    conversationEntries[0],
    "metadata",
    "entry-0000000000000000.json"
  );
  const outsideMetadata = path.join(outsideRoot, "metadata.json");
  await writeFile(outsideMetadata, "{}\n", "utf8");
  await rm(metadataPath);
  await symlink(outsideMetadata, metadataPath, "file");
  await assert.rejects(
    () => pathStore.readConversation(escapedId),
    /symlink|unsafe|安全/i
  );
}

async function crashFixture(point: ConversationStoreV2FaultPoint): Promise<{
  storageRootPath: string;
  cleanStore: FileConversationStoreV2;
  commit: ConversationCommitV2;
}> {
  const storageRootPath = await mkdtemp(path.join(tmpdir(), `echoink-conversation-${point}-`));
  let injected = false;
  const crashingStore = new FileConversationStoreV2({
    storageRootPath,
    faultInjector: (candidate) => {
      if (!injected && candidate === point) {
        injected = true;
        throw new ConversationStoreV2SimulatedCrash(point);
      }
    }
  });
  const commit = conversationCommit({
    revision: 0,
    commitId: `commit-${point}`
  });
  await assert.rejects(
    () => crashingStore.commitConversation(commit, {
      expectedRevision: null,
      expectedCommitId: null
    }),
    ConversationStoreV2SimulatedCrash
  );
  assert.equal(injected, true);
  return {
    storageRootPath,
    cleanStore: new FileConversationStoreV2({ storageRootPath }),
    commit
  };
}

function conversationCommit(options: {
  conversationId?: string;
  revision?: number;
  commitId?: string;
  title?: string;
  previousMetadata?: ConversationMetadataV2;
} = {}): ConversationCommitV2 {
  const conversationId = options.conversationId ?? "conversation-v2";
  const messages = [
    {
      ...message("message-a", "context-a", 1),
      workflowRunId: "workflow-a",
      attemptId: "attempt-a"
    },
    message("message-b", "context-b", 2)
  ];
  return finalizeConversationCommitV2({
    conversationId,
    revision: options.revision ?? 0,
    commitId: options.commitId ?? "commit-v2",
    previousMetadata: options.previousMetadata,
    title: options.title ?? "Conversation V2",
    kind: "chat",
    currentContext: currentContext("context-b", 2),
    messages,
    snapshot: snapshot("context-b", ["message-b"], 2, conversationId),
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 2 + (options.revision ?? 0)
  });
}

function manifestValidationProof(): RecordMigrationValidationProof {
  const result = validateRecordMigration(
    SOURCE_INVENTORY,
    TARGET_INVENTORY
  );
  assert.equal(result.report.status, "ready");
  assert.ok(result.proof);
  return result.proof;
}

function presentation(): Presentation {
  return {
    schemaVersion: 1,
    itemType: "chat-message",
    title: "Visible message",
    status: "completed",
    details: "Product-visible details"
  };
}

function message(id: string, contextId: string, offset: number): MessageV2 {
  return {
    schemaVersion: 2,
    recordType: "conversation-message",
    id,
    role: offset % 2 === 0 ? "assistant" : "user",
    text: `message ${id}`,
    previewText: `preview ${id}`,
    raw: {
      ref: `raw/${id}.md`,
      size: 128,
      lines: 4,
      truncatedForPreview: true
    },
    presentation: presentation(),
    contextId,
    createdAt: BASE_TIME + offset
  };
}

function snapshot(
  contextId: string,
  messageIds: string[],
  contextGeneration: number,
  conversationId = "conversation-v2"
): SnapshotV2 {
  return {
    schemaVersion: 2,
    recordType: "conversation-snapshot",
    conversationId,
    contextId,
    contextGeneration,
    version: `snapshot-${contextId}`,
    goal: "Preserve the user goal",
    currentState: "Current product-visible state",
    decisions: ["Decision A"],
    constraints: ["Constraint A"],
    openLoops: ["Open loop A"],
    keyReferences: ["Reference A"],
    rollingSummary: messageIds.length ? `summary ${contextId}` : "",
    ...(messageIds.length
      ? {
          summarizedFromMessageId: messageIds[0],
          summarizedThroughMessageId: messageIds[messageIds.length - 1]
        }
      : {}),
    sourceMessageCount: messageIds.length,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + messageIds.length
  };
}

function currentContext(id: string, generation: number): {
  id: string;
  generation: number;
  cwd: string;
  workspaceFingerprint: string;
} {
  return {
    id,
    generation,
    cwd: "/vault",
    workspaceFingerprint: WORKSPACE_FINGERPRINT
  };
}

function assertContractCode(
  action: () => unknown,
  code: ConversationV2ContractError["code"]
): void {
  assert.throws(
    action,
    (error: unknown) => (
      error instanceof ConversationV2ContractError
      && error.code === code
    )
  );
}

function withoutKey<T extends object>(
  value: T,
  key: string
): Record<string, unknown> {
  const clone = { ...value } as Record<string, unknown>;
  delete clone[key];
  return clone;
}

if (process.env.ECHOINK_RUN_CONVERSATION_STORE_V2_TEST === "1") {
  runHarnessV2ConversationStoreV2Tests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
