import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ChatMessage,
  StoredSession
} from "../../settings/settings";
import type { SessionContextSnapshot } from "../contracts/context";
import {
  validateConversationCommitV2,
  type ConversationCommitV2,
  type JsonValue,
  type MessageV2,
  type Presentation,
  type SnapshotV2
} from "../contracts/conversation-v2";
import {
  FileConversationStore,
  validateChatMessage,
  type ConversationStoreMigrationImportPlanBinding
} from "../conversation/conversation-store";
import {
  assertConversationStoreV1ExportGenerationId,
  CONVERSATION_STORE_V1_EXPORT_GENERATION_PREFIX,
  conversationStoreV1ExportGenerationRoot,
  conversationStoreV1ExportsRoot
} from "../conversation/conversation-store-paths";
import {
  conversationStoreV2Root,
  FileConversationStoreV2
} from "../conversation/conversation-store-v2";
import { FileRunRecordStore } from "../ledger/run-record-store";
import { NativeExecutionStore } from "../native/native-execution-store";
import {
  resolveConversationStoreSelection
} from "../conversation/store-selection";
import {
  FileConversationStoreRestoreManifest,
  advanceConversationStoreRestoreManifestToActive,
  advanceConversationStoreRestoreManifestToValidated,
  createCopyingConversationStoreRestoreManifest,
  type ConversationStoreRestoreManifest
} from "../conversation/store-restore-manifest";
import {
  conversationMigrationInventoryFromLegacySessions,
  conversationMigrationInventoryFromV2Commits
} from "./conversation-migration-projection";
import {
  inspectConversationV2MigrationOwnerProof
} from "./conversation-migration-owner-proof";
import {
  publishRecordMigrationConflictQuarantine,
  type RecordMigrationConflictQuarantineReceipt
} from "./record-migration-conflict-quarantine";
import {
  migrationContentDigest,
  opaqueMigrationRef,
  validateRecordMigration,
  type RecordMigrationInventory,
  type RecordMigrationOwnerEdge,
  type RecordMigrationValidationProof,
  type RecordMigrationValidationReport
} from "./record-migration-validator";

const EXPORT_STAGING_DIRECTORY = ".staging";
const PLAN_FILE = "plan.json";
const STORE_DIRECTORY = "store";
const CONFLICTS_DIRECTORY = "migration-conflicts";
const VALIDATION_FILE = "validation.json";
const EXPORT_PLAN_SCHEMA_VERSION = 1 as const;
const MAX_EXPORT_RECORD_BYTES = 4 * 1024 * 1024;

export interface ConversationStoreV1ExportPlan {
  schemaVersion: typeof EXPORT_PLAN_SCHEMA_VERSION;
  recordType: "conversation-store-v1-export-plan";
  projection: "conversation-portable-v1";
  generationId: string;
  sourceStoreVersion: "v2";
  targetStoreVersion: "v1";
  sourceManifestDigest: string;
  sourceFingerprint: string;
  digest: string;
}

export interface PrepareConversationStoreV1ExportInput {
  storageRootPath: string;
  sourceStore?: FileConversationStoreV2;
  externalOwnerEdges?: readonly RecordMigrationOwnerEdge[];
}

export interface InspectConversationStoreV1ExportInput
extends PrepareConversationStoreV1ExportInput {
  generationId: string;
  expectedSourceFingerprint: string;
}

export interface ConversationStoreV1ExportValidation {
  source: RecordMigrationInventory;
  target: RecordMigrationInventory;
  report: RecordMigrationValidationReport;
  proof: RecordMigrationValidationProof | null;
}

export interface PrepareConversationStoreV1ExportResult
extends ConversationStoreV1ExportValidation {
  generationId: string;
  generationRootPath: string;
  storeRootPath: string;
  plan: ConversationStoreV1ExportPlan;
  validationPath: string;
  createdConversationCount: number;
  reusedConversationCount: number;
  conflictingConversationCount: number;
  createdDeletionTombstoneCount: number;
  reusedDeletionTombstoneCount: number;
  conflictingDeletionTombstoneCount: number;
  conflictQuarantineReceipt:
    | RecordMigrationConflictQuarantineReceipt
    | null;
}

export interface PrepareConversationStoreV1RestoreRouteInput {
  storageRootPath: string;
  generationId: string;
  expectedSourceFingerprint: string;
  externalOwnerEdges?: readonly RecordMigrationOwnerEdge[];
  copyingCommitId: string;
  validatedCommitId: string;
  createdAt: number;
  validatedAt: number;
  restoreManifestStore?: FileConversationStoreRestoreManifest;
}

export interface ActivateConversationStoreV1RestoreRouteInput {
  storageRootPath: string;
  externalOwnerEdges?: readonly RecordMigrationOwnerEdge[];
  activeCommitId: string;
  activatedAt: number;
  restoreManifestStore?: FileConversationStoreRestoreManifest;
}

interface ConversationMigrationOwnerStoresInput {
  settingsDataPath: string;
  nativeStore: NativeExecutionStore;
  runStore: FileRunRecordStore;
}

export type PrepareConversationStoreV1ExportWithOwnerStoresInput =
  Omit<PrepareConversationStoreV1ExportInput, "externalOwnerEdges">
  & ConversationMigrationOwnerStoresInput;

export type PrepareConversationStoreV1RestoreRouteWithOwnerStoresInput =
  Omit<PrepareConversationStoreV1RestoreRouteInput, "externalOwnerEdges">
  & ConversationMigrationOwnerStoresInput;

export type ActivateConversationStoreV1RestoreRouteWithOwnerStoresInput =
  Omit<ActivateConversationStoreV1RestoreRouteInput, "externalOwnerEdges">
  & ConversationMigrationOwnerStoresInput;

export {
  conversationStoreV1ExportGenerationRoot,
  conversationStoreV1ExportsRoot
} from "../conversation/conversation-store-paths";

/**
 * Create or resume one deterministic, side-by-side V1 compatibility export.
 * It never mutates the retained legacy V1 root, changes the active reader, or
 * deletes V2 bytes.
 */
export async function prepareConversationStoreV1Export(
  input: PrepareConversationStoreV1ExportInput
): Promise<PrepareConversationStoreV1ExportResult> {
  const storageRootPath = safeStorageRoot(input.storageRootPath);
  const sourceStore = input.sourceStore ?? new FileConversationStoreV2({
    storageRootPath
  });
  assertSourceStoreBelongsToStorageRoot(sourceStore, storageRootPath);
  const sourceManifestDigest = await activeV2ManifestDigest(storageRootPath);
  const externalOwnerEdges = [...(input.externalOwnerEdges ?? [])];
  const firstSource = await inspectSourceInventory(
    sourceStore,
    externalOwnerEdges
  );
  const secondSource = await inspectSourceInventory(
    sourceStore,
    externalOwnerEdges
  );
  if (firstSource.fingerprint !== secondSource.fingerprint) {
    throw new Error(
      "Conversation V1 export blocked: V2 source drifted before planning"
    );
  }
  const sourceSnapshot = await sourceStore.inspectMigrationSnapshot();
  assertV2LineageHasExternalOwners(
    sourceSnapshot.commits,
    externalOwnerEdges
  );
  const generationId = createConversationStoreV1ExportGenerationId(
    sourceManifestDigest,
    secondSource.fingerprint
  );
  const generationRootPath = conversationStoreV1ExportGenerationRoot(
    storageRootPath,
    generationId
  );
  const exportsRootPath = conversationStoreV1ExportsRoot(storageRootPath);
  const stagingRootPath = path.join(
    exportsRootPath,
    EXPORT_STAGING_DIRECTORY
  );
  await ensurePlainDirectory(storageRootPath);
  await ensurePlainDirectory(exportsRootPath);
  await ensurePlainDirectory(stagingRootPath);
  await ensurePlainDirectory(generationRootPath);
  await assertExportGenerationLayout(generationRootPath);
  const plan = createConversationStoreV1ExportPlan(
    generationId,
    sourceManifestDigest,
    secondSource.fingerprint
  );
  await publishImmutableJson({
    targetPath: path.join(generationRootPath, PLAN_FILE),
    stagingRootPath,
    value: plan,
    label: "Conversation V1 export plan"
  });
  await assertExportGenerationLayout(generationRootPath);

  const storeRootPath = path.join(generationRootPath, STORE_DIRECTORY);
  const planBinding = conversationStoreV1ExportPlanBinding(plan);
  const targetStore = new FileConversationStore({
    rootPath: storeRootPath
  });
  const initialTargetSnapshot = await targetStore.inspectMigrationSnapshot();
  conversationMigrationInventoryFromLegacySessions(
    initialTargetSnapshot.sessions,
    {
      externalOwnerEdges,
      deletionTombstones: initialTargetSnapshot.deletionTombstones
    }
  );

  let createdConversationCount = 0;
  let reusedConversationCount = 0;
  let conflictingConversationCount = 0;
  let createdDeletionTombstoneCount = 0;
  let reusedDeletionTombstoneCount = 0;
  let conflictingDeletionTombstoneCount = 0;

  for (const tombstone of sourceSnapshot.deletionTombstones) {
    const status = await targetStore.importMigrationDeletionTombstone(
      tombstone,
      planBinding
    );
    if (status === "created") createdDeletionTombstoneCount += 1;
    else if (status === "reused") reusedDeletionTombstoneCount += 1;
    else conflictingDeletionTombstoneCount += 1;
  }
  for (const commit of sourceSnapshot.commits) {
    const status = await targetStore.importMigrationSession(
      projectConversationCommitV2ToStoredSessionV1(commit),
      planBinding
    );
    if (status === "created") createdConversationCount += 1;
    else if (status === "reused") reusedConversationCount += 1;
    else conflictingConversationCount += 1;
  }

  const validation = await inspectAndValidateConversationStoreV1Export({
    ...input,
    storageRootPath,
    sourceStore,
    externalOwnerEdges,
    generationId,
    expectedSourceFingerprint: plan.sourceFingerprint
  });
  const conflictQuarantineReceipt = validation.report.quarantine
    ? await publishRecordMigrationConflictQuarantine({
      rootPath: path.join(generationRootPath, CONFLICTS_DIRECTORY),
      quarantine: validation.report.quarantine
    })
    : null;
  const validationPath = path.join(generationRootPath, VALIDATION_FILE);
  await publishImmutableJson({
    targetPath: validationPath,
    stagingRootPath,
    value: validation.report,
    label: "Conversation V1 export validation"
  });
  await assertExportGenerationLayout(generationRootPath);
  return {
    ...validation,
    generationId,
    generationRootPath,
    storeRootPath,
    plan,
    validationPath,
    createdConversationCount,
    reusedConversationCount,
    conflictingConversationCount,
    createdDeletionTombstoneCount,
    reusedDeletionTombstoneCount,
    conflictingDeletionTombstoneCount,
    conflictQuarantineReceipt
  };
}

export async function prepareConversationStoreV1ExportWithOwnerStores(
  input: PrepareConversationStoreV1ExportWithOwnerStoresInput
): Promise<PrepareConversationStoreV1ExportResult> {
  const sourceStore = input.sourceStore ?? new FileConversationStoreV2({
    storageRootPath: input.storageRootPath
  });
  const externalOwnerEdges = await v2OwnerEdgesFromStores(
    sourceStore,
    input
  );
  return await prepareConversationStoreV1Export({
    storageRootPath: input.storageRootPath,
    sourceStore,
    externalOwnerEdges
  });
}

export async function inspectAndValidateConversationStoreV1Export(
  input: InspectConversationStoreV1ExportInput
): Promise<ConversationStoreV1ExportValidation> {
  const storageRootPath = safeStorageRoot(input.storageRootPath);
  const sourceStore = input.sourceStore ?? new FileConversationStoreV2({
    storageRootPath
  });
  assertSourceStoreBelongsToStorageRoot(sourceStore, storageRootPath);
  const generationRootPath = conversationStoreV1ExportGenerationRoot(
    storageRootPath,
    input.generationId
  );
  await assertExportGenerationLayout(generationRootPath);
  const plan = await readExportPlan(
    path.join(generationRootPath, PLAN_FILE)
  );
  if (
    plan.generationId !== input.generationId
    || plan.sourceFingerprint !== input.expectedSourceFingerprint
  ) {
    throw new Error(
      "Conversation V1 export blocked: generation plan identity changed"
    );
  }
  if (
    await activeV2ManifestDigest(storageRootPath)
      !== plan.sourceManifestDigest
  ) {
    throw new Error(
      "Conversation V1 export blocked: active V2 manifest changed"
    );
  }
  const targetStore = new FileConversationStore({
    rootPath: path.join(generationRootPath, STORE_DIRECTORY)
  });
  const externalOwnerEdges = [...(input.externalOwnerEdges ?? [])];
  const inspect = async (): Promise<{
    source: RecordMigrationInventory;
    target: RecordMigrationInventory;
  }> => {
    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      sourceStore.inspectMigrationSnapshot(),
      targetStore.inspectMigrationSnapshot()
    ]);
    assertV2LineageHasExternalOwners(
      sourceSnapshot.commits,
      externalOwnerEdges
    );
    return {
      source: conversationMigrationInventoryFromV2Commits(
        sourceSnapshot.commits,
        "v2",
        {
          externalOwnerEdges,
          deletionTombstones: sourceSnapshot.deletionTombstones
        }
      ),
      target: conversationMigrationInventoryFromLegacySessions(
        targetSnapshot.sessions,
        {
          externalOwnerEdges,
          deletionTombstones: targetSnapshot.deletionTombstones
        }
      )
    };
  };
  const first = await inspect();
  const second = await inspect();
  if (
    first.source.fingerprint !== second.source.fingerprint
    || first.target.fingerprint !== second.target.fingerprint
  ) {
    throw new Error(
      "Conversation V1 export blocked: source or target drifted during validation"
    );
  }
  if (second.source.fingerprint !== plan.sourceFingerprint) {
    throw new Error(
      "Conversation V1 export blocked: active V2 changed after the export plan"
    );
  }
  const validation = validateRecordMigration(
    second.source,
    second.target
  );
  return {
    ...second,
    report: validation.report,
    proof: validation.proof
  };
}

export async function prepareConversationStoreV1RestoreRoute(
  input: PrepareConversationStoreV1RestoreRouteInput
): Promise<ConversationStoreRestoreManifest> {
  const storageRootPath = safeStorageRoot(input.storageRootPath);
  const generationRootPath = conversationStoreV1ExportGenerationRoot(
    storageRootPath,
    input.generationId
  );
  const plan = await readExportPlan(
    path.join(generationRootPath, PLAN_FILE)
  );
  if (
    plan.generationId !== input.generationId
    || plan.sourceFingerprint !== input.expectedSourceFingerprint
  ) {
    throw new Error(
      "Conversation V1 restore route blocked: export plan identity changed"
    );
  }
  const store = input.restoreManifestStore
    ?? new FileConversationStoreRestoreManifest({ storageRootPath });
  let current = await store.read();
  if (current) {
    assertRestoreRouteMatchesPlan(current, plan);
    if (current.migrationState === "reverse-active") return current;
  }
  const validation = await inspectAndValidateConversationStoreV1Export({
    storageRootPath,
    generationId: input.generationId,
    expectedSourceFingerprint: input.expectedSourceFingerprint,
    externalOwnerEdges: input.externalOwnerEdges
  });
  if (validation.report.status !== "ready" || !validation.proof) {
    throw new Error(
      "Conversation V1 restore route blocked: export is not ready"
    );
  }
  if (!current) {
    const copying = createCopyingConversationStoreRestoreManifest({
      commitId: input.copyingCommitId,
      sourceManifestDigest: plan.sourceManifestDigest,
      sourceFingerprint: plan.sourceFingerprint,
      generationId: plan.generationId,
      planDigest: plan.digest,
      createdAt: input.createdAt
    });
    current = await store.compareAndSwap(copying, {
      expectedRevision: null,
      expectedCommitId: null
    });
  }
  assertRestoreRouteMatchesPlan(current, plan);
  if (current.migrationState === "reverse-validated") {
    if (current.targetFingerprint !== validation.target.fingerprint) {
      throw new Error(
        "Conversation V1 restore route blocked: validated target changed"
      );
    }
    return current;
  }
  const validated =
    advanceConversationStoreRestoreManifestToValidated(current, {
      commitId: input.validatedCommitId,
      proof: validation.proof,
      updatedAt: input.validatedAt
    });
  return await store.compareAndSwap(validated, {
    expectedRevision: current.revision,
    expectedCommitId: current.commitId
  });
}

export async function prepareConversationStoreV1RestoreRouteWithOwnerStores(
  input: PrepareConversationStoreV1RestoreRouteWithOwnerStoresInput
): Promise<ConversationStoreRestoreManifest> {
  const externalOwnerEdges = await v2OwnerEdgesFromStores(
    new FileConversationStoreV2({
      storageRootPath: input.storageRootPath
    }),
    input
  );
  return await prepareConversationStoreV1RestoreRoute({
    storageRootPath: input.storageRootPath,
    generationId: input.generationId,
    expectedSourceFingerprint: input.expectedSourceFingerprint,
    externalOwnerEdges,
    copyingCommitId: input.copyingCommitId,
    validatedCommitId: input.validatedCommitId,
    createdAt: input.createdAt,
    validatedAt: input.validatedAt,
    restoreManifestStore: input.restoreManifestStore
  });
}

export async function activateConversationStoreV1RestoreRoute(
  input: ActivateConversationStoreV1RestoreRouteInput
): Promise<ConversationStoreRestoreManifest> {
  const storageRootPath = safeStorageRoot(input.storageRootPath);
  const store = input.restoreManifestStore
    ?? new FileConversationStoreRestoreManifest({ storageRootPath });
  const current = await store.read();
  if (!current) {
    throw new Error(
      "Conversation V1 restore activation requires a validated route"
    );
  }
  if (current.migrationState === "reverse-active") return current;
  if (current.migrationState !== "reverse-validated") {
    throw new Error(
      "Conversation V1 restore activation requires a validated route"
    );
  }
  const validation = await inspectAndValidateConversationStoreV1Export({
    storageRootPath,
    generationId: current.generationId,
    expectedSourceFingerprint: current.sourceFingerprint,
    externalOwnerEdges: input.externalOwnerEdges
  });
  if (
    validation.report.status !== "ready"
    || !validation.proof
    || validation.target.fingerprint !== current.targetFingerprint
  ) {
    throw new Error(
      "Conversation V1 restore activation blocked: fresh validation failed"
    );
  }
  const active = advanceConversationStoreRestoreManifestToActive(
    current,
    {
      commitId: input.activeCommitId,
      proof: validation.proof,
      activatedAt: input.activatedAt
    }
  );
  return await store.compareAndSwap(active, {
    expectedRevision: current.revision,
    expectedCommitId: current.commitId
  });
}

export async function activateConversationStoreV1RestoreRouteWithOwnerStores(
  input: ActivateConversationStoreV1RestoreRouteWithOwnerStoresInput
): Promise<ConversationStoreRestoreManifest> {
  const externalOwnerEdges = await v2OwnerEdgesFromStores(
    new FileConversationStoreV2({
      storageRootPath: input.storageRootPath
    }),
    input
  );
  return await activateConversationStoreV1RestoreRoute({
    storageRootPath: input.storageRootPath,
    externalOwnerEdges,
    activeCommitId: input.activeCommitId,
    activatedAt: input.activatedAt,
    restoreManifestStore: input.restoreManifestStore
  });
}

export function projectConversationCommitV2ToStoredSessionV1(
  commitInput: ConversationCommitV2
): StoredSession {
  const commit = validateConversationCommitV2(commitInput);
  const { metadata, payload } = commit;
  const firstCurrentIndex = payload.messages.findIndex(
    (message) => message.contextId === metadata.currentContext.id
  );
  const contextStartsAfterMessageId = firstCurrentIndex > 0
    ? payload.messages[firstCurrentIndex - 1].id
    : undefined;
  const messages = payload.messages.map(
    projectConversationMessageV2ToChatMessage
  );
  const contextSnapshot = payload.snapshot
    ? projectConversationSnapshotV2ToSessionSnapshot(payload.snapshot)
    : undefined;
  return {
    id: metadata.conversationId,
    title: metadata.title,
    kind: metadata.kind,
    revision: metadata.currentContext.generation,
    generation: metadata.currentContext.generation,
    contextId: metadata.currentContext.id,
    ...(contextStartsAfterMessageId
      ? { contextStartsAfterMessageId }
      : {}),
    commitId: metadata.commitId,
    workspaceFingerprint: metadata.currentContext.workspaceFingerprint,
    ...(contextSnapshot ? { contextSnapshot } : {}),
    cwd: metadata.currentContext.cwd,
    messages,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt
  };
}

export function projectConversationMessageV2ToChatMessage(
  message: MessageV2
): ChatMessage {
  const presentation = message.presentation;
  const projected: ChatMessage = {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.previewText !== undefined
      ? { previewText: message.previewText }
      : {}),
    ...(message.raw
      ? {
        rawRef: message.raw.ref,
        rawSize: message.raw.size,
        rawLines: message.raw.lines,
        rawTruncatedForPreview: message.raw.truncatedForPreview
      }
      : {}),
    ...(presentation?.itemType !== undefined
      ? { itemType: presentation.itemType }
      : {}),
    ...(presentation?.title !== undefined
      ? { title: presentation.title }
      : {}),
    ...(presentation?.status !== undefined
      ? { status: presentation.status }
      : {}),
    ...(presentation?.details !== undefined
      ? { details: presentation.details }
      : {}),
    ...presentationComplexFields(presentation),
    createdAt: message.createdAt,
    ...(message.completedAt !== undefined
      ? { completedAt: message.completedAt }
      : {})
  };
  return validateChatMessage(projected);
}

function projectConversationSnapshotV2ToSessionSnapshot(
  snapshot: SnapshotV2
): SessionContextSnapshot {
  return {
    sessionId: snapshot.conversationId,
    contextId: snapshot.contextId,
    generation: snapshot.contextGeneration,
    version: snapshot.version,
    goal: snapshot.goal,
    currentState: snapshot.currentState,
    decisions: [...snapshot.decisions],
    constraints: [...snapshot.constraints],
    openLoops: [...snapshot.openLoops],
    keyReferences: [...snapshot.keyReferences],
    rollingSummary: snapshot.rollingSummary,
    ...(snapshot.summarizedFromMessageId
      ? { summarizedFromMessageId: snapshot.summarizedFromMessageId }
      : {}),
    ...(snapshot.summarizedThroughMessageId
      ? { summarizedThroughMessageId: snapshot.summarizedThroughMessageId }
      : {}),
    sourceMessageCount: snapshot.sourceMessageCount,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt
  };
}

function presentationComplexFields(
  presentation: Presentation | undefined
): Pick<
  ChatMessage,
  | "attachments"
  | "images"
  | "files"
  | "citations"
  | "diffSummary"
  | "knowledgeBaseUi"
> {
  if (!presentation) return {};
  return {
    ...(presentation.attachments !== undefined
      ? {
        attachments: cloneJson(
          presentation.attachments
        ) as unknown as ChatMessage["attachments"]
      }
      : {}),
    ...(presentation.images !== undefined
      ? {
        images: cloneJson(
          presentation.images
        ) as unknown as ChatMessage["images"]
      }
      : {}),
    ...(presentation.files !== undefined
      ? {
        files: cloneJson(
          presentation.files
        ) as unknown as ChatMessage["files"]
      }
      : {}),
    ...(presentation.citations !== undefined
      ? {
        citations: cloneJson(
          presentation.citations
        ) as unknown as ChatMessage["citations"]
      }
      : {}),
    ...(presentation.diffSummary !== undefined
      ? {
        diffSummary: cloneJson(
          presentation.diffSummary
        ) as unknown as ChatMessage["diffSummary"]
      }
      : {}),
    ...(presentation.knowledgeBaseUi !== undefined
      ? {
        knowledgeBaseUi: cloneJson(
          presentation.knowledgeBaseUi
        ) as unknown as ChatMessage["knowledgeBaseUi"]
      }
      : {})
  };
}

async function inspectSourceInventory(
  sourceStore: FileConversationStoreV2,
  externalOwnerEdges: readonly RecordMigrationOwnerEdge[]
): Promise<RecordMigrationInventory> {
  const snapshot = await sourceStore.inspectMigrationSnapshot();
  assertV2LineageHasExternalOwners(snapshot.commits, externalOwnerEdges);
  return conversationMigrationInventoryFromV2Commits(
    snapshot.commits,
    "v2",
    {
      externalOwnerEdges,
      deletionTombstones: snapshot.deletionTombstones
    }
  );
}

function assertV2LineageHasExternalOwners(
  commits: readonly ConversationCommitV2[],
  externalOwnerEdges: readonly RecordMigrationOwnerEdge[]
): void {
  const runOwnerRefs = new Set(
    externalOwnerEdges
      .filter((edge) => edge.kind === "run-record-owner")
      .map((edge) => edge.ownerRef)
  );
  for (const commit of commits) {
    for (const message of commit.payload.messages) {
      if (!message.workflowRunId && !message.attemptId) continue;
      const ownerRef = opaqueMigrationRef(
        "message",
        commit.metadata.conversationId,
        message.id
      );
      if (!runOwnerRefs.has(ownerRef)) {
        throw new Error(
          "Conversation V1 export blocked: V2 execution lineage lacks Run Store owner proof"
        );
      }
    }
  }
}

async function v2OwnerEdgesFromStores(
  sourceStore: FileConversationStoreV2,
  input: ConversationMigrationOwnerStoresInput
): Promise<RecordMigrationOwnerEdge[]> {
  const source = await sourceStore.inspectMigrationSnapshot();
  const proof = await inspectConversationV2MigrationOwnerProof({
    sourceCommits: source.commits,
    settingsDataPath: input.settingsDataPath,
    nativeStore: input.nativeStore,
    runStore: input.runStore
  });
  if (proof.status !== "ready") {
    throw new Error(
      "Conversation V1 export blocked: external owner Stores are not ready"
    );
  }
  return proof.targetExternalOwnerEdges;
}

export function createConversationStoreV1ExportGenerationId(
  sourceManifestDigest: string,
  sourceFingerprint: string
): string {
  const token = createHash("sha256")
    .update(JSON.stringify({
      projection: "conversation-portable-v1",
      sourceManifestDigest,
      sourceFingerprint
    }), "utf8")
    .digest("hex");
  return `${CONVERSATION_STORE_V1_EXPORT_GENERATION_PREFIX}${token}`;
}

export function createConversationStoreV1ExportPlan(
  generationId: string,
  sourceManifestDigest: string,
  sourceFingerprint: string
): ConversationStoreV1ExportPlan {
  const withoutDigest = {
    schemaVersion: EXPORT_PLAN_SCHEMA_VERSION,
    recordType: "conversation-store-v1-export-plan" as const,
    projection: "conversation-portable-v1" as const,
    generationId,
    sourceStoreVersion: "v2" as const,
    targetStoreVersion: "v1" as const,
    sourceManifestDigest,
    sourceFingerprint
  };
  return {
    ...withoutDigest,
    digest: migrationContentDigest(withoutDigest)
  };
}

export function conversationStoreV1ExportPlanBinding(
  plan: ConversationStoreV1ExportPlan
): ConversationStoreMigrationImportPlanBinding {
  return {
    generationId: plan.generationId,
    planDigest: plan.digest
  };
}

async function readExportPlan(
  absolutePath: string
): Promise<ConversationStoreV1ExportPlan> {
  const parsed = await readJsonSafely(
    absolutePath,
    "Conversation V1 export plan"
  );
  const record = requirePlainRecord(
    parsed,
    "Conversation V1 export plan"
  );
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "projection",
    "generationId",
    "sourceStoreVersion",
    "targetStoreVersion",
    "sourceManifestDigest",
    "sourceFingerprint",
    "digest"
  ], "Conversation V1 export plan");
  if (
    record.schemaVersion !== EXPORT_PLAN_SCHEMA_VERSION
    || record.recordType !== "conversation-store-v1-export-plan"
    || record.projection !== "conversation-portable-v1"
    || record.sourceStoreVersion !== "v2"
    || record.targetStoreVersion !== "v1"
    || typeof record.generationId !== "string"
    || typeof record.sourceManifestDigest !== "string"
    || typeof record.sourceFingerprint !== "string"
    || typeof record.digest !== "string"
  ) {
    throw new Error("Conversation V1 export plan schema is invalid");
  }
  assertConversationStoreV1ExportGenerationId(record.generationId);
  const plan = record as unknown as ConversationStoreV1ExportPlan;
  if (plan.digest !== createConversationStoreV1ExportPlan(
    plan.generationId,
    plan.sourceManifestDigest,
    plan.sourceFingerprint
  ).digest) {
    throw new Error("Conversation V1 export plan digest is invalid");
  }
  return plan;
}

async function activeV2ManifestDigest(
  storageRootPath: string
): Promise<string> {
  const selection = await resolveConversationStoreSelection(storageRootPath);
  if (
    selection.activeStore !== "v2"
    || selection.storeRef !== "canonical-v2"
    || selection.manifest?.migrationState !== "active"
  ) {
    throw new Error(
      "Conversation V1 export requires the manifest-selected active V2 Store"
    );
  }
  return selection.manifest.digest;
}

function assertRestoreRouteMatchesPlan(
  manifest: ConversationStoreRestoreManifest,
  plan: ConversationStoreV1ExportPlan
): void {
  if (
    manifest.sourceManifestDigest !== plan.sourceManifestDigest
    || manifest.sourceFingerprint !== plan.sourceFingerprint
    || manifest.generationId !== plan.generationId
    || manifest.planDigest !== plan.digest
  ) {
    throw new Error(
      "Conversation V1 restore route conflicts with the export plan"
    );
  }
}

async function assertExportGenerationLayout(
  generationRootPath: string
): Promise<void> {
  const rootStat = await lstatOrNull(generationRootPath);
  if (!rootStat) {
    throw new Error("Conversation V1 export generation is missing");
  }
  assertPlainDirectory(rootStat, "Conversation V1 export generation");
  const allowed = new Map<string, "file" | "directory">([
    [PLAN_FILE, "file"],
    [STORE_DIRECTORY, "directory"],
    [CONFLICTS_DIRECTORY, "directory"],
    [VALIDATION_FILE, "file"]
  ]);
  const entries = await fsp.readdir(
    generationRootPath,
    { withFileTypes: true }
  );
  for (const entry of entries) {
    const expected = allowed.get(entry.name);
    if (
      !expected
      || entry.isSymbolicLink()
      || (expected === "file" ? !entry.isFile() : !entry.isDirectory())
    ) {
      throw new Error(
        `Conversation V1 export generation contains unsafe entry: ${entry.name}`
      );
    }
  }
}

async function publishImmutableJson(input: {
  targetPath: string;
  stagingRootPath: string;
  value: unknown;
  label: string;
}): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(input.value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_EXPORT_RECORD_BYTES) {
    throw new Error(`${input.label} exceeds the safety size limit`);
  }
  const existing = await lstatOrNull(input.targetPath);
  if (existing) {
    const readback = await readJsonSafely(input.targetPath, input.label);
    if (!isDeepStrictEqual(readback, input.value)) {
      throw new Error(`${input.label} conflicts with an existing record`);
    }
    return;
  }
  const stagedPath = path.join(
    input.stagingRootPath,
    `.export-${randomUUID()}.tmp`
  );
  let staged = false;
  try {
    const handle = await fsp.open(
      stagedPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | noFollowFlag(),
      0o600
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
      assertSafeRegularFile(await handle.stat(), input.label, [1]);
    } finally {
      await handle.close();
    }
    staged = true;
    await syncDirectory(input.stagingRootPath);
    try {
      await fsp.link(stagedPath, input.targetPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const winner = await readJsonSafely(input.targetPath, input.label);
      if (!isDeepStrictEqual(winner, input.value)) {
        throw new Error(`${input.label} has a different publication winner`);
      }
    }
    await syncDirectory(path.dirname(input.targetPath));
    await fsp.unlink(stagedPath);
    staged = false;
    await syncDirectory(input.stagingRootPath);
  } catch (error) {
    if (staged) {
      await fsp.unlink(stagedPath).catch(() => undefined);
      await syncDirectory(input.stagingRootPath).catch(() => undefined);
    }
    throw error;
  }
}

async function readJsonSafely(
  absolutePath: string,
  label: string
): Promise<unknown> {
  const handle = await fsp.open(
    absolutePath,
    fsConstants.O_RDONLY | noFollowFlag()
  );
  try {
    const before = await handle.stat();
    assertSafeRegularFile(before, label, [1, 2]);
    if (before.size > MAX_EXPORT_RECORD_BYTES) {
      throw new Error(`${label} exceeds the safety size limit`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileVersion(before, after) || bytes.byteLength !== before.size) {
      throw new Error(`${label} changed during read`);
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensurePlainDirectory(absolutePath: string): Promise<void> {
  const before = await lstatOrNull(absolutePath);
  if (!before) {
    await fsp.mkdir(absolutePath, { recursive: false, mode: 0o700 });
  }
  assertPlainDirectory(await fsp.lstat(absolutePath), absolutePath);
}

function assertPlainDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory`);
  }
}

function assertSafeRegularFile(
  stat: Stats,
  label: string,
  allowedLinkCounts: readonly number[]
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !allowedLinkCounts.includes(Number(stat.nlink))
  ) {
    throw new Error(`${label} must be a safe regular file`);
  }
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  );
}

async function syncDirectory(absolutePath: string): Promise<void> {
  const handle = await fsp.open(
    absolutePath,
    fsConstants.O_RDONLY | noFollowFlag()
  );
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function safeStorageRoot(value: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error("Conversation V1 export storage root cannot be filesystem root");
  }
  return resolved;
}

function assertSourceStoreBelongsToStorageRoot(
  sourceStore: FileConversationStoreV2,
  storageRootPath: string
): void {
  const expectedRootPath = conversationStoreV2Root(storageRootPath);
  if (
    path.resolve(sourceStore.storageRootPath) !== storageRootPath
    || path.resolve(sourceStore.rootPath) !== expectedRootPath
  ) {
    throw new Error(
      "Conversation V1 export source Store is not the canonical V2 root"
    );
  }
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const expected = new Set(keys);
  if (
    Object.keys(record).some((key) => !expected.has(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
  return await fsp.lstat(absolutePath).catch((error) => {
    if (
      error
      && typeof error === "object"
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) return null;
    throw error;
  });
}
