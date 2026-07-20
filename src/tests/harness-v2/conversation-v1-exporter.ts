import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  finalizeConversationCommitV2,
  type ConversationCommitV2,
  type MessageV2,
  type SnapshotV2
} from "../../harness/contracts/conversation-v2";
import {
  createConversationDeletionTombstone,
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../../harness/conversation/conversation-store-v2";
import {
  FileConversationStoreManifest,
  advanceConversationStoreManifestToActive,
  advanceConversationStoreManifestToValidated,
  createCopyingConversationStoreManifest,
  resolveConversationStoreSelection
} from "../../harness/conversation/store-manifest";
import {
  conversationMigrationInventoryFromV2Commits,
  legacyExternalOwnerEdges,
  prepareConversationStoreV2Migration
} from "../../harness/lifecycle/conversation-migration-projection";
import {
  conversationStoreV1ExportPlanBinding,
  conversationStoreV1ExportGenerationRoot,
  createConversationStoreV1ExportPlan,
  createConversationStoreV1ExportGenerationId,
  inspectAndValidateConversationStoreV1Export,
  prepareConversationStoreV1Export,
  projectConversationCommitV2ToStoredSessionV1
} from "../../harness/lifecycle/conversation-v1-exporter";
import {
  assertRecordMigrationValidationProof,
  opaqueMigrationRef,
  type RecordMigrationOwnerEdge
} from "../../harness/lifecycle/record-migration-validator";
import type { StoredSession } from "../../settings/settings";

const BASE_TIME = 1_721_260_800_000;
const WORKSPACE_FINGERPRINT = `sha256:${"6".repeat(64)}`;

export async function runHarnessV2ConversationV1ExporterTests():
Promise<void> {
  await assertV2ToV1ExportAndReverseRestoreRoundTrip();
  await assertExporterConflictsNeverOverwriteAndStayOpaque();
  await assertRestoreWriterRecoversSeedAndMarkerCrashWindows();
  await assertExporterRequiresActiveV2AndStrictTargetIndex();
}

async function assertV2ToV1ExportAndReverseRestoreRoundTrip():
Promise<void> {
  const fixture = await activeV2Fixture("roundtrip");
  const legacyBefore = await directoryFileDigests(fixture.legacyRootPath);
  const evolved = await evolveActiveV2(fixture);
  const exported = await prepareConversationStoreV1Export({
    storageRootPath: fixture.storageRootPath,
    externalOwnerEdges: evolved.externalOwnerEdges
  });
  assert.equal(exported.report.status, "ready");
  assert.ok(exported.proof);
  assert.equal(exported.createdConversationCount, 2);
  assert.equal(exported.createdDeletionTombstoneCount, 1);
  assert.equal(exported.conflictingConversationCount, 0);
  assert.equal(exported.conflictingDeletionTombstoneCount, 0);
  assertRecordMigrationValidationProof(exported.proof, {
    domain: "conversation",
    projection: "conversation-portable-v1",
    sourceStoreVersion: "v2",
    targetStoreVersion: "v1",
    sourceFingerprint: exported.source.fingerprint,
    targetFingerprint: exported.target.fingerprint
  });

  const exportStore = new FileConversationStore({
    rootPath: exported.storeRootPath
  });
  const exportedSnapshot = await exportStore.inspectMigrationSnapshot();
  assert.equal(exportedSnapshot.sessions.length, 2);
  assert.deepEqual(
    exportedSnapshot.deletionTombstones,
    [evolved.tombstone]
  );
  const primary = exportedSnapshot.sessions.find(
    (session) => session.id === fixture.legacySession.id
  );
  assert.ok(primary);
  assert.equal(primary.messages.at(-1)?.text, "V2-only final answer");
  assert.equal(
    primary.contextStartsAfterMessageId,
    fixture.legacySession.messages.at(-1)?.id
  );
  assert.equal(primary.contextSnapshot?.contextId, "context-v2-new");
  assert.equal(primary.messages.at(-1)?.attachments?.[0]?.path, "proof.md");
  assert.equal(primary.messages.at(-1)?.images?.[0]?.path, "preview.png");
  assert.equal(primary.messages.at(-1)?.files?.[0]?.displayPath, "proof.md");
  assert.equal(primary.messages.at(-1)?.diffSummary?.totalFiles, 1);
  assert.equal(primary.messages.at(-1)?.citations?.status, "strong");
  assert.equal(
    primary.messages.at(-1)?.knowledgeBaseUi?.kind,
    "maintain-run"
  );
  assert.equal("workflowRunId" in primary.messages.at(-1)!, false);
  assert.equal("attemptId" in primary.messages.at(-1)!, false);

  const planBefore = await readFile(
    path.join(exported.generationRootPath, "plan.json"),
    "utf8"
  );
  const validationBefore = await readFile(exported.validationPath, "utf8");
  const replayed = await prepareConversationStoreV1Export({
    storageRootPath: fixture.storageRootPath,
    externalOwnerEdges: evolved.externalOwnerEdges
  });
  assert.equal(replayed.createdConversationCount, 0);
  assert.equal(replayed.reusedConversationCount, 2);
  assert.equal(replayed.createdDeletionTombstoneCount, 0);
  assert.equal(replayed.reusedDeletionTombstoneCount, 1);
  assert.equal(
    await readFile(
      path.join(exported.generationRootPath, "plan.json"),
      "utf8"
    ),
    planBefore
  );
  assert.equal(
    await readFile(exported.validationPath, "utf8"),
    validationBefore
  );

  const restoredStorageRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-v1-export-restored-v2-")
  );
  const restoredV2 = new FileConversationStoreV2({
    storageRootPath: restoredStorageRoot
  });
  const restored = await prepareConversationStoreV2Migration({
    sourceStore: exportStore,
    targetStore: restoredV2,
    sourceExternalOwnerEdges: evolved.externalOwnerEdges,
    targetExternalOwnerEdges: evolved.externalOwnerEdges
  });
  assert.equal(restored.report.status, "ready");
  assert.equal(restored.createdConversationCount, 2);
  assert.equal(restored.createdDeletionTombstoneCount, 1);
  const restoredSnapshot = await restoredV2.inspectMigrationSnapshot();
  const sourceSnapshot = await fixture.v2Store.inspectMigrationSnapshot();
  const sourcePortable = conversationMigrationInventoryFromV2Commits(
    sourceSnapshot.commits,
    "v2",
    {
      externalOwnerEdges: evolved.externalOwnerEdges,
      deletionTombstones: sourceSnapshot.deletionTombstones
    }
  );
  const restoredPortable = conversationMigrationInventoryFromV2Commits(
    restoredSnapshot.commits,
    "v2",
    {
      externalOwnerEdges: evolved.externalOwnerEdges,
      deletionTombstones: restoredSnapshot.deletionTombstones
    }
  );
  assert.deepEqual(restoredPortable.subjects, sourcePortable.subjects);
  assert.deepEqual(restoredPortable.ownerEdges, sourcePortable.ownerEdges);
  assert.deepEqual(
    await directoryFileDigests(fixture.legacyRootPath),
    legacyBefore,
    "reverse export must not modify the retained legacy V1 bytes"
  );
}

async function assertExporterConflictsNeverOverwriteAndStayOpaque():
Promise<void> {
  const fixture = await activeV2Fixture("conflict");
  const evolved = await evolveActiveV2(fixture);
  const extraEdge: RecordMigrationOwnerEdge = {
    kind: "settings-projection-owner",
    ownerRef: opaqueMigrationRef(
      "conversation",
      fixture.legacySession.id
    ),
    resourceRef: opaqueMigrationRef("settings", "conflict-generation")
  };
  const externalOwnerEdges = [
    ...evolved.externalOwnerEdges,
    extraEdge
  ];
  const sourceSnapshot = await fixture.v2Store.inspectMigrationSnapshot();
  const sourceInventory = conversationMigrationInventoryFromV2Commits(
    sourceSnapshot.commits,
    "v2",
    {
      externalOwnerEdges,
      deletionTombstones: sourceSnapshot.deletionTombstones
    }
  );
  const selection = await resolveConversationStoreSelection(
    fixture.storageRootPath
  );
  assert.ok(selection.manifest);
  const generationId = createConversationStoreV1ExportGenerationId(
    selection.manifest.digest,
    sourceInventory.fingerprint
  );
  const generationRootPath = conversationStoreV1ExportGenerationRoot(
    fixture.storageRootPath,
    generationId
  );
  const plan = createConversationStoreV1ExportPlan(
    generationId,
    selection.manifest.digest,
    sourceInventory.fingerprint
  );
  await mkdir(generationRootPath, { recursive: true });
  await writeFile(
    path.join(generationRootPath, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8"
  );
  const planBinding = conversationStoreV1ExportPlanBinding(plan);
  const conflictingStore = new FileConversationStore({
    rootPath: path.join(generationRootPath, "store")
  });
  const sourceCommit = sourceSnapshot.commits.find(
    (commit) =>
      commit.metadata.conversationId === fixture.legacySession.id
  );
  assert.ok(sourceCommit);
  const conflicting = projectConversationCommitV2ToStoredSessionV1(
    sourceCommit
  );
  conflicting.messages[0].text = "conflicting secret export body";
  assert.equal(
    await conflictingStore.importMigrationSession(
      conflicting,
      planBinding
    ),
    "created"
  );
  const conflictingSessionRoot = path.join(
    generationRootPath,
    "store",
    "sessions",
    conflicting.id
  );
  const bytesBefore = await directoryFileDigests(
    conflictingSessionRoot
  );

  const blocked = await prepareConversationStoreV1Export({
    storageRootPath: fixture.storageRootPath,
    externalOwnerEdges
  });
  assert.equal(blocked.report.status, "blocked");
  assert.equal(blocked.proof, null);
  assert.equal(blocked.conflictingConversationCount, 1);
  assert.ok(blocked.conflictQuarantineReceipt);
  assert.deepEqual(
    await directoryFileDigests(conflictingSessionRoot),
    bytesBefore,
    "same-ID conflict must never overwrite the target generation"
  );
  const reportBytes = JSON.stringify(blocked.report);
  const quarantineBytes = await readFile(
    blocked.conflictQuarantineReceipt!.absolutePath,
    "utf8"
  );
  for (const secret of [
    fixture.legacySession.id,
    "conflicting secret export body",
    fixture.storageRootPath
  ]) {
    assert.doesNotMatch(reportBytes, new RegExp(escapeRegExp(secret)));
    assert.doesNotMatch(quarantineBytes, new RegExp(escapeRegExp(secret)));
  }
}

async function assertRestoreWriterRecoversSeedAndMarkerCrashWindows():
Promise<void> {
  const fixture = await activeV2Fixture("crash");
  const sourceCommit = (
    await fixture.v2Store.inspectMigrationSnapshot()
  ).commits[0];
  const candidate = projectConversationCommitV2ToStoredSessionV1(
    sourceCommit
  );

  const renameCrashRoot = managedFixtureStoreRoot("a");
  const renamePlanBinding = await installFixtureExportPlan(
    renameCrashRoot,
    "a"
  );
  let renameCrashed = false;
  const renameCrashStore = new FileConversationStore({
    rootPath: renameCrashRoot,
    afterPristineDirectoryCommitBeforeIndex() {
      if (!renameCrashed) {
        renameCrashed = true;
        throw new Error("simulated migration seed rename crash");
      }
    }
  });
  await assert.rejects(
    () => renameCrashStore.importMigrationSession(
      candidate,
      renamePlanBinding
    ),
    /seed rename crash/
  );
  const renameRecovered = new FileConversationStore({
    rootPath: renameCrashRoot
  });
  assert.equal(
    await renameRecovered.importMigrationSession(
      candidate,
      renamePlanBinding
    ),
    "created"
  );
  assert.deepEqual(await renameRecovered.readSession(candidate.id), candidate);

  const markerCrashRoot = managedFixtureStoreRoot("b");
  const markerPlanBinding = await installFixtureExportPlan(
    markerCrashRoot,
    "b"
  );
  let markerCalls = 0;
  const markerCrashStore = new FileConversationStore({
    rootPath: markerCrashRoot,
    beforeContextCommitMarker() {
      markerCalls += 1;
      if (markerCalls === 2) {
        throw new Error("simulated migration marker crash");
      }
    }
  });
  await assert.rejects(
    () => markerCrashStore.importMigrationSession(
      candidate,
      markerPlanBinding
    ),
    /marker crash/
  );
  const markerRecovered = new FileConversationStore({
    rootPath: markerCrashRoot
  });
  assert.equal(
    await markerRecovered.importMigrationSession(
      candidate,
      markerPlanBinding
    ),
    "created"
  );
  assert.deepEqual(await markerRecovered.readSession(candidate.id), candidate);
  assert.equal(
    await markerRecovered.importMigrationSession(
      candidate,
      markerPlanBinding
    ),
    "reused"
  );
}

async function assertExporterRequiresActiveV2AndStrictTargetIndex():
Promise<void> {
  const absentManifestRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-v1-export-no-manifest-")
  );
  const source = new FileConversationStoreV2({
    storageRootPath: absentManifestRoot
  });
  await source.commitConversation(v2OnlyCommit("manifest-required"), {
    expectedRevision: null,
    expectedCommitId: null
  });
  await assert.rejects(
    () => prepareConversationStoreV1Export({
      storageRootPath: absentManifestRoot
    }),
    /requires the manifest-selected active V2 Store/
  );

  const missingRunOwnerFixture = await activeV2Fixture(
    "missing-run-owner"
  );
  await evolveActiveV2(missingRunOwnerFixture);
  await assert.rejects(
    () => prepareConversationStoreV1Export({
      storageRootPath: missingRunOwnerFixture.storageRootPath,
      externalOwnerEdges: missingRunOwnerFixture.externalOwnerEdges
    }),
    /execution lineage lacks Run Store owner proof/
  );

  const driftFixture = await activeV2Fixture("source-drift");
  const driftExport = await prepareConversationStoreV1Export({
    storageRootPath: driftFixture.storageRootPath,
    externalOwnerEdges: driftFixture.externalOwnerEdges
  });
  await driftFixture.v2Store.commitConversation(
    v2OnlyCommit("source-drift-after-plan"),
    {
      expectedRevision: null,
      expectedCommitId: null
    }
  );
  await assert.rejects(
    () => inspectAndValidateConversationStoreV1Export({
      storageRootPath: driftFixture.storageRootPath,
      externalOwnerEdges: driftFixture.externalOwnerEdges,
      generationId: driftExport.generationId,
      expectedSourceFingerprint: driftExport.source.fingerprint
    }),
    /active V2 changed after the export plan/
  );

  const fixture = await activeV2Fixture("strict-index");
  const nonCanonicalSource = new FileConversationStoreV2({
    storageRootPath: fixture.storageRootPath,
    rootPath: path.join(fixture.storageRootPath, "shadow-conversations-v2")
  });
  await assert.rejects(
    () => prepareConversationStoreV1Export({
      storageRootPath: fixture.storageRootPath,
      sourceStore: nonCanonicalSource,
      externalOwnerEdges: fixture.externalOwnerEdges
    }),
    /source Store is not the canonical V2 root/
  );

  const tamperedPlanRoot = managedFixtureStoreRoot("c");
  const tamperedPlanBinding = await installFixtureExportPlan(
    tamperedPlanRoot,
    "c"
  );
  const tamperedPlanPath = path.join(
    path.dirname(tamperedPlanRoot),
    "plan.json"
  );
  const tamperedPlan = JSON.parse(
    await readFile(tamperedPlanPath, "utf8")
  ) as Record<string, unknown>;
  tamperedPlan.sourceFingerprint = `sha256:${"d".repeat(64)}`;
  await writeFile(
    tamperedPlanPath,
    `${JSON.stringify(tamperedPlan, null, 2)}\n`,
    "utf8"
  );
  const tamperedCandidate = projectConversationCommitV2ToStoredSessionV1(
    (await fixture.v2Store.inspectMigrationSnapshot()).commits[0]
  );
  await assert.rejects(
    () => new FileConversationStore({
      rootPath: tamperedPlanRoot
    }).importMigrationSession(
      tamperedCandidate,
      tamperedPlanBinding
    ),
    /plan binding is invalid/
  );

  const exported = await prepareConversationStoreV1Export({
    storageRootPath: fixture.storageRootPath,
    externalOwnerEdges: fixture.externalOwnerEdges
  });
  const indexPath = path.join(exported.storeRootPath, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as object;
  await writeFile(
    indexPath,
    `${JSON.stringify({ ...index, futureIndexField: true })}\n`,
    "utf8"
  );
  await assert.rejects(
    () => new FileConversationStore({
      rootPath: exported.storeRootPath
    }).inspectMigrationSnapshot(),
    /schema is unknown or corrupt/
  );
}

interface ActiveV2Fixture {
  storageRootPath: string;
  legacyRootPath: string;
  legacyStore: FileConversationStore;
  legacySession: StoredSession;
  v2Store: FileConversationStoreV2;
  externalOwnerEdges: RecordMigrationOwnerEdge[];
}

async function activeV2Fixture(
  suffix: string
): Promise<ActiveV2Fixture> {
  const storageRootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-v1-export-${suffix}-`)
  );
  const legacyRootPath = path.join(storageRootPath, "conversations");
  const legacyStore = new FileConversationStore({
    rootPath: legacyRootPath,
    now: () => BASE_TIME + 10
  });
  await legacyStore.createPristineSession({
    id: `conversation-${suffix}`,
    title: `Legacy ${suffix}`,
    kind: "knowledge-base",
    revision: 1,
    generation: 1,
    contextId: "context-legacy",
    commitId: `legacy-${suffix}`,
    workspaceFingerprint: WORKSPACE_FINGERPRINT,
    cwd: "/vault",
    messages: [],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME
  });
  const seed = await legacyStore.readSession(`conversation-${suffix}`);
  assert.ok(seed);
  seed.messages = [{
    id: `legacy-message-${suffix}`,
    role: "user",
    text: "Legacy retained Markdown **body**",
    rawRef: `raw/${suffix}.md`,
    rawSize: 32,
    rawLines: 2,
    rawTruncatedForPreview: false,
    createdAt: BASE_TIME + 1
  }];
  seed.updatedAt = BASE_TIME + 2;
  await legacyStore.upsertSession(seed);
  const legacySession = await legacyStore.readSession(seed.id);
  assert.ok(legacySession);
  const externalOwnerEdges = legacyExternalOwnerEdges([legacySession]);

  const v2Store = new FileConversationStoreV2({ storageRootPath });
  const prepared = await prepareConversationStoreV2Migration({
    sourceStore: legacyStore,
    targetStore: v2Store,
    targetExternalOwnerEdges: externalOwnerEdges
  });
  assert.equal(prepared.report.status, "ready");
  assert.ok(prepared.proof);
  const manifestStore = new FileConversationStoreManifest({
    storageRootPath
  });
  const copying = createCopyingConversationStoreManifest({
    commitId: `copying-${suffix}`,
    sourceFingerprint: prepared.source.fingerprint,
    createdAt: BASE_TIME + 3
  });
  await manifestStore.compareAndSwap(copying, {
    expectedRevision: null,
    expectedCommitId: null
  });
  const validated = advanceConversationStoreManifestToValidated(copying, {
    commitId: `validated-${suffix}`,
    proof: prepared.proof,
    updatedAt: BASE_TIME + 4
  });
  await manifestStore.compareAndSwap(validated, {
    expectedRevision: copying.revision,
    expectedCommitId: copying.commitId
  });
  const active = advanceConversationStoreManifestToActive(validated, {
    commitId: `active-${suffix}`,
    activatedAt: BASE_TIME + 5
  });
  await manifestStore.compareAndSwap(active, {
    expectedRevision: validated.revision,
    expectedCommitId: validated.commitId
  });
  return {
    storageRootPath,
    legacyRootPath,
    legacyStore,
    legacySession,
    v2Store,
    externalOwnerEdges
  };
}

async function evolveActiveV2(fixture: ActiveV2Fixture): Promise<{
  externalOwnerEdges: RecordMigrationOwnerEdge[];
  tombstone: ReturnType<typeof createConversationDeletionTombstone>;
}> {
  const current = await fixture.v2Store.readConversation(
    fixture.legacySession.id
  );
  assert.ok(current);
  const newUserId = `${fixture.legacySession.id}-v2-user`;
  const newAssistantId = `${fixture.legacySession.id}-v2-assistant`;
  const messages: MessageV2[] = [
    ...current.payload.messages,
    {
      schemaVersion: 2,
      recordType: "conversation-message",
      id: newUserId,
      role: "user",
      text: "V2-only request",
      contextId: "context-v2-new",
      workflowRunId: "workflow-v2-only",
      attemptId: "attempt-v2-only",
      createdAt: BASE_TIME + 20
    },
    {
      schemaVersion: 2,
      recordType: "conversation-message",
      id: newAssistantId,
      role: "assistant",
      text: "V2-only final answer",
      contextId: "context-v2-new",
      presentation: {
        schemaVersion: 1,
        itemType: "chat-message",
        title: "Recovered answer",
        status: "completed",
        details: "Portable product presentation",
        attachments: [{
          type: "file",
          name: "proof.md",
          path: "proof.md"
        }],
        images: [{
          type: "image",
          name: "preview.png",
          path: "preview.png"
        }],
        files: [{
          name: "proof.md",
          path: "proof.md",
          displayPath: "proof.md",
          kind: "vault",
          openable: true
        }],
        citations: {
          status: "strong",
          counts: {
            wiki: 1,
            journal: 0,
            outputs: 0
          },
          citations: [{
            bucket: "wiki",
            title: "Portable proof",
            path: "proof.md",
            excerptLines: ["Validated export"],
            relevance: "strong",
            reason: "Round-trip fixture",
            score: 3
          }]
        },
        diffSummary: {
          totalFiles: 1,
          added: 2,
          removed: 0,
          files: [{
            path: "proof.md",
            kind: "add",
            added: 2,
            removed: 0
          }]
        },
        knowledgeBaseUi: {
          kind: "maintain-run",
          mode: "maintain",
          title: "Portable maintenance",
          subtitle: "Validated",
          icon: "shield-check",
          phases: [{
            id: "complete",
            label: "Complete",
            icon: "check-circle",
            motion: "complete"
          }]
        }
      },
      createdAt: BASE_TIME + 21,
      completedAt: BASE_TIME + 22
    }
  ];
  const snapshot = snapshotV2(
    fixture.legacySession.id,
    "context-v2-new",
    2,
    [newUserId, newAssistantId]
  );
  const next = finalizeConversationCommitV2({
    conversationId: current.metadata.conversationId,
    title: current.metadata.title,
    kind: current.metadata.kind,
    revision: current.metadata.revision + 1,
    commitId: `${current.metadata.commitId}-v2-next`,
    previousMetadata: current.metadata,
    currentContext: {
      id: "context-v2-new",
      generation: 2,
      cwd: current.metadata.currentContext.cwd,
      workspaceFingerprint:
        current.metadata.currentContext.workspaceFingerprint
    },
    messages,
    snapshot,
    createdAt: current.metadata.createdAt,
    updatedAt: BASE_TIME + 22
  });
  await fixture.v2Store.commitConversation(next, {
    expectedRevision: current.metadata.revision,
    expectedCommitId: current.metadata.commitId
  });
  const extra = v2OnlyCommit(`${fixture.legacySession.id}-extra`);
  await fixture.v2Store.commitConversation(extra, {
    expectedRevision: null,
    expectedCommitId: null
  });
  const tombstone = createConversationDeletionTombstone({
    conversationId: `${fixture.legacySession.id}-deleted`,
    mutationId: "v2-delete-mutation",
    tombstoneId: "v2-delete-tombstone",
    sourceGeneration: 1,
    sourceCommitId: "v2-deleted-source",
    sourceContentRevision: `sha256:${"c".repeat(64)}`,
    deletedAt: BASE_TIME + 23
  });
  await fixture.v2Store.commitDeletionTombstone(tombstone);
  const runOwner: RecordMigrationOwnerEdge = {
    kind: "run-record-owner",
    ownerRef: opaqueMigrationRef(
      "message",
      fixture.legacySession.id,
      newUserId
    ),
    resourceRef: opaqueMigrationRef(
      "run-record",
      "workflow-v2-only",
      "attempt-v2-only"
    )
  };
  return {
    externalOwnerEdges: [...fixture.externalOwnerEdges, runOwner],
    tombstone
  };
}

function v2OnlyCommit(conversationId: string): ConversationCommitV2 {
  const messageId = `${conversationId}-message`;
  return finalizeConversationCommitV2({
    conversationId,
    title: "V2-only Conversation",
    kind: "chat",
    revision: 0,
    commitId: `${conversationId}-commit`,
    currentContext: {
      id: `${conversationId}-context`,
      generation: 1,
      cwd: "/vault",
      workspaceFingerprint: WORKSPACE_FINGERPRINT
    },
    messages: [{
      schemaVersion: 2,
      recordType: "conversation-message",
      id: messageId,
      role: "assistant",
      text: "V2-only portable body",
      contextId: `${conversationId}-context`,
      createdAt: BASE_TIME + 30
    }],
    snapshot: snapshotV2(
      conversationId,
      `${conversationId}-context`,
      1,
      [messageId]
    ),
    createdAt: BASE_TIME + 30,
    updatedAt: BASE_TIME + 30
  });
}

function snapshotV2(
  conversationId: string,
  contextId: string,
  generation: number,
  messageIds: string[]
): SnapshotV2 {
  return {
    schemaVersion: 2,
    recordType: "conversation-snapshot",
    conversationId,
    contextId,
    contextGeneration: generation,
    version: `snapshot-${contextId}`,
    goal: "Preserve portable Conversation state",
    currentState: "Ready for reverse export",
    decisions: ["Never overwrite legacy V1"],
    constraints: ["Keep V2 active during export"],
    openLoops: [],
    keyReferences: ["proof.md"],
    rollingSummary: "Portable snapshot summary",
    summarizedFromMessageId: messageIds[0],
    summarizedThroughMessageId: messageIds.at(-1),
    sourceMessageCount: messageIds.length,
    createdAt: BASE_TIME + 20,
    updatedAt: BASE_TIME + 22
  };
}

function managedFixtureStoreRoot(token: string): string {
  return path.join(
    tmpdir(),
    `echoink-v1-writer-${token}-${process.pid}`,
    "conversation-v1-exports",
    `export-${token.repeat(64)}`,
    "store"
  );
}

async function installFixtureExportPlan(
  storeRootPath: string,
  token: string
): Promise<ReturnType<typeof conversationStoreV1ExportPlanBinding>> {
  const generationRootPath = path.dirname(storeRootPath);
  const generationId = path.basename(generationRootPath);
  const plan = createConversationStoreV1ExportPlan(
    generationId,
    `sha256:${token.repeat(64)}`,
    `sha256:${token.repeat(64)}`
  );
  await mkdir(generationRootPath, { recursive: true });
  await writeFile(
    path.join(generationRootPath, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8"
  );
  return conversationStoreV1ExportPlanBinding(plan);
}

async function directoryFileDigests(
  rootPath: string
): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const visit = async (currentPath: string): Promise<void> => {
    const entries = await readdir(currentPath, {
      withFileTypes: true
    });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, absolutePath);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        output[relativePath] = createHash("sha256")
          .update(await readFile(absolutePath))
          .digest("hex");
      } else {
        throw new Error(`Unexpected fixture entry: ${relativePath}`);
      }
    }
  };
  await visit(rootPath);
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.env.ECHOINK_RUN_CONVERSATION_V1_EXPORTER_TEST === "1") {
  runHarnessV2ConversationV1ExporterTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
