import { createHash } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  DurableAppendOnlyCasError,
  durableAppendOnlyChainPath,
  publishDurableAppendOnlyChain,
  publishDurableAppendOnlyEntry,
  readDurableRegularFile,
  resolveDurableAppendOnlyLayout,
  resolveDurablePlainRoot,
  type DurableAppendOnlyFaultPoint,
  type DurableAppendOnlyLayout
} from "../storage/durable-append-only-cas";
import {
  parseRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  recordMutationDigest,
  stableRecordMutationStringify
} from "../lifecycle/record-mutation-contract";
import {
  createRecordMutationSourceParticipantReceipt,
  type RecordMutationSourceParticipantAdapter,
  type RecordMutationSourceParticipantObservation,
  type RecordMutationSourceParticipantReceipt
} from "../lifecycle/record-mutation-source-participant";
import type { WorkflowArtifactKind } from "../contracts/run-record";

const ARTIFACT_LIFECYCLE_SCHEMA_VERSION = 1 as const;
const ARTIFACT_LIFECYCLE_NAMESPACE = "workflow-artifact-lifecycle";
const ENTRY_PREFIX = "revision-";
const ENTRY_WIDTH = 12;
const ENTRY_PATTERN = /^revision-([0-9]{12})\.json$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_REVISIONS = 129;
const artifactMutationTails = new Map<string, Promise<void>>();

export interface ArtifactSourceDeletionV1 {
  mutationId: string;
  conversationId: string;
  deletedAt: number;
  forwardEffectId: string;
  restoredAt?: number;
  restoreEffectId?: string;
}

export interface WorkflowArtifactLifecycleRecordV1 {
  schemaVersion: typeof ARTIFACT_LIFECYCLE_SCHEMA_VERSION;
  kind: "workflow-artifact-lifecycle";
  artifactId: string;
  artifactKind: WorkflowArtifactKind;
  sourceConversationIds: string[];
  sourceDeletions: ArtifactSourceDeletionV1[];
  createdAt: number;
  updatedAt: number;
  revision: number;
  previousRevision: number | null;
  previousDigest: string | null;
  digest: string;
}

export interface LoadedWorkflowArtifactLifecycleRecord {
  rootPath: string;
  chainToken: string;
  chain: WorkflowArtifactLifecycleRecordV1[];
  record: WorkflowArtifactLifecycleRecordV1;
}

export interface WorkflowArtifactConversationInventory {
  conversationId: string;
  artifacts: WorkflowArtifactLifecycleRecordV1[];
  snapshotDigest: string;
}

export interface ArtifactSourceDeletionAdapterInput {
  storageRootPath: string;
  rootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
  participantId: string;
  artifactKind?: WorkflowArtifactKind;
  faultInjector?: (
    point: DurableAppendOnlyFaultPoint,
    phase: "source-deleted" | "source-restored"
  ) => void | Promise<void>;
}

export async function initializeWorkflowArtifactLifecycleStore(
  rootPathInput: string
): Promise<string> {
  const rootPath = path.resolve(rootPathInput);
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const canonical = await resolveDurablePlainRoot(
    rootPath,
    "Workflow Artifact Lifecycle root"
  );
  const layout = await resolveDurableAppendOnlyLayout(
    canonical,
    ARTIFACT_LIFECYCLE_NAMESPACE,
    true
  );
  if (!layout) {
    throw new Error("Workflow Artifact Lifecycle namespace 创建失败");
  }
  return canonical;
}

export async function createWorkflowArtifactLifecycleRecord(input: {
  rootPath: string;
  artifactId: string;
  artifactKind: WorkflowArtifactKind;
  sourceConversationIds: string[];
  createdAt: number;
}): Promise<LoadedWorkflowArtifactLifecycleRecord> {
  const rootPath = await initializeWorkflowArtifactLifecycleStore(input.rootPath);
  return await withArtifactMutation(rootPath, input.artifactId, async () => {
    const layout = await requireLayout(rootPath, true);
    if (!layout) {
      throw new Error("Workflow Artifact Lifecycle layout 创建失败");
    }
    const candidate = createInitialRecord(input);
    const chainToken = artifactChainToken(candidate.artifactId);
    const existing = await loadFromLayout(layout, candidate.artifactId);
    if (existing) {
      if (
        existing.chain[0].artifactKind !== candidate.artifactKind
        || stableRecordMutationStringify(
          existing.chain[0].sourceConversationIds
        ) !== stableRecordMutationStringify(candidate.sourceConversationIds)
      ) {
        throw new Error(
          `Workflow Artifact ${candidate.artifactId} registration conflicts`
        );
      }
      return existing;
    }
    try {
      await publishDurableAppendOnlyChain(
        layout,
        chainToken,
        entryName(0),
        recordBytes(candidate),
        { maxBytes: MAX_RECORD_BYTES }
      );
    } catch (error) {
      if (
        !(error instanceof DurableAppendOnlyCasError)
        || error.code !== "already_exists"
      ) {
        throw error;
      }
    }
    const readback = await loadFromLayout(layout, candidate.artifactId);
    if (!readback || readback.chain[0].digest !== candidate.digest) {
      throw new Error("Workflow Artifact Lifecycle create readback 不一致");
    }
    return readback;
  });
}

export async function loadWorkflowArtifactLifecycleRecord(
  rootPathInput: string,
  artifactIdInput: string
): Promise<LoadedWorkflowArtifactLifecycleRecord | null> {
  const rootPath = await resolveDurablePlainRoot(
    rootPathInput,
    "Workflow Artifact Lifecycle root"
  );
  const artifactId = requireSafeId(artifactIdInput, "artifactId");
  const layout = await requireLayout(rootPath, false);
  return layout ? await loadFromLayout(layout, artifactId) : null;
}

/**
 * Strict read-only scan for destructive Conversation planning. A missing Store
 * is an empty inventory and is never initialized. Any unknown entry, partial
 * staging state or corrupt chain blocks the entire scan because it may conceal
 * an Artifact owned by the target Conversation.
 */
export async function inventoryWorkflowArtifactsByConversation(
  rootPathInput: string,
  conversationIdInput: string
): Promise<WorkflowArtifactConversationInventory> {
  const rootPath = path.resolve(rootPathInput);
  const conversationId = requireSafeId(
    conversationIdInput,
    "conversationId"
  );
  const before = await scanWorkflowArtifactLifecycleRecords(rootPath);
  const after = await scanWorkflowArtifactLifecycleRecords(rootPath);
  if (after.snapshotDigest !== before.snapshotDigest) {
    throw new Error(
      "Workflow Artifact Lifecycle changed during Conversation inventory"
    );
  }
  return {
    conversationId,
    artifacts: before.records
      .filter((record) =>
        record.sourceConversationIds.includes(conversationId)
      )
      .map(cloneArtifactLifecycleRecord),
    snapshotDigest: recordMutationDigest({
      conversationId,
      storeSnapshotDigest: before.snapshotDigest,
      artifacts: before.records
        .filter((record) =>
          record.sourceConversationIds.includes(conversationId)
        )
    })
  };
}

export function createArtifactSourceDeletionAdapter(
  input: ArtifactSourceDeletionAdapterInput
): RecordMutationSourceParticipantAdapter {
  const rootBinding = parseRecordRootBindingRef(input.rootBinding);
  const rootPath = path.resolve(input.rootPath);
  let authorityHeld = false;
  const requireAuthority = (): void => {
    if (!authorityHeld) {
      throw new Error(
        "Workflow Artifact source deletion requires mutation authority"
      );
    }
  };
  return {
    participantId: input.participantId,
    recordKind: "artifact",
    storageRootPath: input.storageRootPath,
    rootPath,
    boundaryRootPath: input.boundaryRootPath,
    rootBinding,
    withMutation: async <T>(action: () => Promise<T>): Promise<T> => (
      await withArtifactMutation(rootPath, input.participantId, async () => {
        if (authorityHeld) {
          throw new Error(
            "Workflow Artifact source deletion authority cannot nest"
          );
        }
        authorityHeld = true;
        try {
          return await action();
        } finally {
          authorityHeld = false;
        }
      })
    ),
    recover: async () => {
      requireAuthority();
    },
    inspect: async (identity) => {
      requireAuthority();
      return await inspectArtifactSourceDeletion({
        rootPath,
        artifactId: identity.participantId,
        mutationId: identity.mutationId,
        conversationId: identity.conversationId,
        artifactKind: input.artifactKind
      });
    },
    stage: async (effect) => {
      requireAuthority();
      return await stageArtifactSourceDeletion({
        rootPath,
        artifactId: effect.participantId,
        mutationId: effect.mutationId,
        conversationId: effect.conversationId,
        artifactKind: input.artifactKind,
        occurredAt: effect.occurredAt,
        faultInjector: input.faultInjector
          ? async (point) => await input.faultInjector?.(
            point,
            "source-deleted"
          )
          : undefined
      });
    },
    restore: async (effect) => {
      requireAuthority();
      return await restoreArtifactSourceDeletion({
        rootPath,
        artifactId: effect.participantId,
        mutationId: effect.mutationId,
        conversationId: effect.conversationId,
        artifactKind: input.artifactKind,
        forwardReceipt: effect.forwardReceipt,
        occurredAt: effect.occurredAt,
        faultInjector: input.faultInjector
          ? async (point) => await input.faultInjector?.(
            point,
            "source-restored"
          )
          : undefined
      });
    }
  };
}

async function inspectArtifactSourceDeletion(input: {
  rootPath: string;
  artifactId: string;
  mutationId: string;
  conversationId: string;
  artifactKind?: WorkflowArtifactKind;
}): Promise<RecordMutationSourceParticipantObservation> {
  const loaded = await loadWorkflowArtifactLifecycleRecord(
    input.rootPath,
    input.artifactId
  );
  if (!loaded) {
    throw new Error(`Workflow Artifact ${input.artifactId} lifecycle 缺失`);
  }
  assertArtifactKind(loaded, input.artifactKind);
  if (!loaded.record.sourceConversationIds.includes(input.conversationId)) {
    throw new Error(
      `Workflow Artifact ${input.artifactId} Conversation lineage 不完整`
    );
  }
  const matches = loaded.record.sourceDeletions.filter(
    (marker) => marker.mutationId === input.mutationId
  );
  if (matches.length > 1) {
    throw new Error(
      `Workflow Artifact ${input.artifactId} source deletion marker 重复`
    );
  }
  const marker = matches[0];
  if (!marker) return { status: "before" };
  if (marker.conversationId !== input.conversationId) {
    throw new Error(
      `Workflow Artifact ${input.artifactId} source deletion Conversation 冲突`
    );
  }
  const forwardReceipt = artifactSourceDeletionReceipt(
    input.artifactId,
    marker,
    "source-deleted"
  );
  if (marker.restoredAt === undefined) {
    return { status: "source-deleted", forwardReceipt };
  }
  return {
    status: "source-restored",
    forwardReceipt,
    restoreReceipt: artifactSourceDeletionReceipt(
      input.artifactId,
      marker,
      "source-restored"
    )
  };
}

async function stageArtifactSourceDeletion(input: {
  rootPath: string;
  artifactId: string;
  mutationId: string;
  conversationId: string;
  artifactKind?: WorkflowArtifactKind;
  occurredAt: number;
  faultInjector?: (point: DurableAppendOnlyFaultPoint) => void | Promise<void>;
}): Promise<RecordMutationSourceParticipantReceipt> {
  const existing = await inspectArtifactSourceDeletion(input);
  if (existing.status === "source-deleted") return existing.forwardReceipt;
  if (existing.status === "source-restored") {
    throw new Error(
      `Workflow Artifact ${input.artifactId} source deletion 已恢复`
    );
  }
  const loaded = await requireArtifact(
    input.rootPath,
    input.artifactId,
    input.artifactKind
  );
  const marker: ArtifactSourceDeletionV1 = {
    mutationId: input.mutationId,
    conversationId: input.conversationId,
    deletedAt: input.occurredAt,
    forwardEffectId: `artifact-source-delete-r${loaded.record.revision + 1}`
  };
  const next = nextRecord(loaded.record, {
    sourceDeletions: [...loaded.record.sourceDeletions, marker].sort(
      (left, right) => left.mutationId.localeCompare(right.mutationId)
    ),
    updatedAt: input.occurredAt
  });
  await appendArtifactRecord(loaded, next, input.faultInjector);
  const readback = await inspectArtifactSourceDeletion(input);
  if (readback.status !== "source-deleted") {
    throw new Error(
      `Workflow Artifact ${input.artifactId} source deletion readback 失败`
    );
  }
  return readback.forwardReceipt;
}

async function restoreArtifactSourceDeletion(input: {
  rootPath: string;
  artifactId: string;
  mutationId: string;
  conversationId: string;
  artifactKind?: WorkflowArtifactKind;
  forwardReceipt: RecordMutationSourceParticipantReceipt;
  occurredAt: number;
  faultInjector?: (point: DurableAppendOnlyFaultPoint) => void | Promise<void>;
}): Promise<RecordMutationSourceParticipantReceipt> {
  const existing = await inspectArtifactSourceDeletion(input);
  if (existing.status === "before") {
    throw new Error(
      `Workflow Artifact ${input.artifactId} source deletion marker 缺失`
    );
  }
  if (existing.forwardReceipt.digest !== input.forwardReceipt.digest) {
    throw new Error(
      `Workflow Artifact ${input.artifactId} source deletion receipt 已变化`
    );
  }
  if (existing.status === "source-restored") return existing.restoreReceipt;
  const loaded = await requireArtifact(
    input.rootPath,
    input.artifactId,
    input.artifactKind
  );
  const markers = loaded.record.sourceDeletions.map((marker) => ({ ...marker }));
  const marker = markers.find(
    (candidate) => candidate.mutationId === input.mutationId
  );
  if (
    !marker
    || marker.conversationId !== input.conversationId
    || marker.restoredAt !== undefined
  ) {
    throw new Error(
      `Workflow Artifact ${input.artifactId} source deletion marker 冲突`
    );
  }
  marker.restoredAt = input.occurredAt;
  marker.restoreEffectId = `artifact-source-restore-r${loaded.record.revision + 1}`;
  const next = nextRecord(loaded.record, {
    sourceDeletions: markers,
    updatedAt: input.occurredAt
  });
  await appendArtifactRecord(loaded, next, input.faultInjector);
  const readback = await inspectArtifactSourceDeletion(input);
  if (readback.status !== "source-restored") {
    throw new Error(
      `Workflow Artifact ${input.artifactId} source restore readback 失败`
    );
  }
  return readback.restoreReceipt;
}

async function appendArtifactRecord(
  loaded: LoadedWorkflowArtifactLifecycleRecord,
  record: WorkflowArtifactLifecycleRecordV1,
  faultInjector:
    | ((point: DurableAppendOnlyFaultPoint) => void | Promise<void>)
    | undefined
): Promise<void> {
  const layout = await requireLayout(loaded.rootPath, false);
  if (!layout) throw new Error("Workflow Artifact Lifecycle layout 缺失");
  await publishDurableAppendOnlyEntry(
    layout,
    loaded.chainToken,
    entryName(record.revision),
    recordBytes(record),
    {
      maxBytes: MAX_RECORD_BYTES,
      faultInjector
    }
  );
  const readback = await loadFromLayout(layout, record.artifactId);
  if (!readback || readback.record.digest !== record.digest) {
    throw new Error("Workflow Artifact Lifecycle append readback 不一致");
  }
}

async function requireArtifact(
  rootPath: string,
  artifactId: string,
  artifactKind?: WorkflowArtifactKind
): Promise<LoadedWorkflowArtifactLifecycleRecord> {
  const loaded = await loadWorkflowArtifactLifecycleRecord(rootPath, artifactId);
  if (!loaded) {
    throw new Error(`Workflow Artifact ${artifactId} lifecycle 缺失`);
  }
  assertArtifactKind(loaded, artifactKind);
  return loaded;
}

function assertArtifactKind(
  loaded: LoadedWorkflowArtifactLifecycleRecord,
  artifactKind: WorkflowArtifactKind | undefined
): void {
  if (
    artifactKind !== undefined
    && loaded.chain[0]?.artifactKind !== artifactKind
  ) {
    throw new Error(
      `Workflow Artifact ${loaded.record.artifactId} kind conflicts`
    );
  }
}

function createInitialRecord(input: {
  artifactId: string;
  artifactKind: WorkflowArtifactKind;
  sourceConversationIds: string[];
  createdAt: number;
}): WorkflowArtifactLifecycleRecordV1 {
  const sourceConversationIds = [...new Set(
    input.sourceConversationIds.map((id) => requireSafeId(id, "conversationId"))
  )].sort(compareText);
  if (!sourceConversationIds.length) {
    throw new Error("Workflow Artifact lifecycle 缺少 source Conversation");
  }
  const draft = {
    schemaVersion: ARTIFACT_LIFECYCLE_SCHEMA_VERSION,
    kind: "workflow-artifact-lifecycle" as const,
    artifactId: requireSafeId(input.artifactId, "artifactId"),
    artifactKind: requireArtifactKind(input.artifactKind),
    sourceConversationIds,
    sourceDeletions: [] as ArtifactSourceDeletionV1[],
    createdAt: requireTimestamp(input.createdAt, "createdAt"),
    updatedAt: requireTimestamp(input.createdAt, "updatedAt"),
    revision: 0,
    previousRevision: null,
    previousDigest: null
  };
  return parseWorkflowArtifactLifecycleRecord({
    ...draft,
    digest: recordMutationDigest(draft)
  });
}

function nextRecord(
  current: WorkflowArtifactLifecycleRecordV1,
  patch: {
    sourceDeletions: ArtifactSourceDeletionV1[];
    updatedAt: number;
  }
): WorkflowArtifactLifecycleRecordV1 {
  const draft = {
    schemaVersion: current.schemaVersion,
    kind: current.kind,
    artifactId: current.artifactId,
    artifactKind: current.artifactKind,
    sourceConversationIds: [...current.sourceConversationIds],
    sourceDeletions: patch.sourceDeletions.map((marker) => ({ ...marker })),
    createdAt: current.createdAt,
    updatedAt: requireTimestamp(patch.updatedAt, "updatedAt"),
    revision: current.revision + 1,
    previousRevision: current.revision,
    previousDigest: current.digest
  };
  if (draft.updatedAt <= current.updatedAt || draft.revision >= MAX_REVISIONS) {
    throw new Error("Workflow Artifact Lifecycle revision 非法");
  }
  return parseWorkflowArtifactLifecycleRecord({
    ...draft,
    digest: recordMutationDigest(draft)
  });
}

function parseWorkflowArtifactLifecycleRecord(
  value: unknown
): WorkflowArtifactLifecycleRecordV1 {
  const record = requirePlainRecord(value, "artifact lifecycle");
  assertExactKeys(record, [
    "schemaVersion",
    "kind",
    "artifactId",
    "artifactKind",
    "sourceConversationIds",
    "sourceDeletions",
    "createdAt",
    "updatedAt",
    "revision",
    "previousRevision",
    "previousDigest",
    "digest"
  ], "artifact lifecycle");
  if (record.schemaVersion !== ARTIFACT_LIFECYCLE_SCHEMA_VERSION) {
    throw new Error("Workflow Artifact Lifecycle schemaVersion 非法");
  }
  if (record.kind !== "workflow-artifact-lifecycle") {
    throw new Error("Workflow Artifact Lifecycle kind 非法");
  }
  if (!Array.isArray(record.sourceConversationIds)) {
    throw new Error("Workflow Artifact sourceConversationIds 非法");
  }
  const sourceConversationIds = record.sourceConversationIds.map(
    (id) => requireSafeId(id, "sourceConversationId")
  );
  if (
    !sourceConversationIds.length
    || new Set(sourceConversationIds).size !== sourceConversationIds.length
    || sourceConversationIds.some(
      (id, index) => id !== [...sourceConversationIds].sort(compareText)[index]
    )
  ) {
    throw new Error("Workflow Artifact sourceConversationIds 非确定性");
  }
  if (!Array.isArray(record.sourceDeletions)) {
    throw new Error("Workflow Artifact sourceDeletions 非法");
  }
  const sourceDeletions = record.sourceDeletions.map(parseSourceDeletion);
  if (
    sourceDeletions.length > 64
    || new Set(sourceDeletions.map((marker) => marker.mutationId)).size
      !== sourceDeletions.length
    || sourceDeletions.some(
      (marker, index) => marker.mutationId
        !== [...sourceDeletions].sort(
          (left, right) => left.mutationId.localeCompare(right.mutationId)
        )[index].mutationId
    )
  ) {
    throw new Error("Workflow Artifact sourceDeletions 非确定性");
  }
  const createdAt = requireTimestamp(record.createdAt, "createdAt");
  const updatedAt = requireTimestamp(record.updatedAt, "updatedAt");
  const revision = requireSafeInteger(record.revision, "revision", 0);
  const previousRevision = record.previousRevision === null
    ? null
    : requireSafeInteger(record.previousRevision, "previousRevision", 0);
  const previousDigest = record.previousDigest === null
    ? null
    : requireDigest(record.previousDigest, "previousDigest");
  if (
    (
      revision === 0
      && (
        previousRevision !== null
        || previousDigest !== null
        || updatedAt !== createdAt
        || sourceDeletions.length
      )
    )
    || (
      revision > 0
      && (
        previousRevision !== revision - 1
        || previousDigest === null
        || updatedAt <= createdAt
      )
    )
  ) {
    throw new Error("Workflow Artifact Lifecycle revision chain 非法");
  }
  const parsed: WorkflowArtifactLifecycleRecordV1 = {
    schemaVersion: ARTIFACT_LIFECYCLE_SCHEMA_VERSION,
    kind: "workflow-artifact-lifecycle",
    artifactId: requireSafeId(record.artifactId, "artifactId"),
    artifactKind: requireArtifactKind(record.artifactKind),
    sourceConversationIds,
    sourceDeletions,
    createdAt,
    updatedAt,
    revision,
    previousRevision,
    previousDigest,
    digest: requireDigest(record.digest, "digest")
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (parsed.digest !== recordMutationDigest(withoutDigest)) {
    throw new Error("Workflow Artifact Lifecycle digest 不匹配");
  }
  return parsed;
}

function parseSourceDeletion(value: unknown): ArtifactSourceDeletionV1 {
  const record = requirePlainRecord(value, "artifact source deletion");
  const restored = record.restoredAt !== undefined;
  assertExactKeys(
    record,
    restored
      ? [
          "mutationId",
          "conversationId",
          "deletedAt",
          "forwardEffectId",
          "restoredAt",
          "restoreEffectId"
        ]
      : [
          "mutationId",
          "conversationId",
          "deletedAt",
          "forwardEffectId"
        ],
    "artifact source deletion"
  );
  const deletedAt = requireTimestamp(record.deletedAt, "deletedAt");
  const marker: ArtifactSourceDeletionV1 = {
    mutationId: requireSafeId(record.mutationId, "mutationId"),
    conversationId: requireSafeId(record.conversationId, "conversationId"),
    deletedAt,
    forwardEffectId: requireSafeId(record.forwardEffectId, "forwardEffectId")
  };
  if (restored) {
    marker.restoredAt = requireTimestamp(record.restoredAt, "restoredAt");
    marker.restoreEffectId = requireSafeId(
      record.restoreEffectId,
      "restoreEffectId"
    );
    if (marker.restoredAt < deletedAt) {
      throw new Error("Workflow Artifact source restore 时间倒退");
    }
  }
  return marker;
}

async function loadFromLayout(
  layout: DurableAppendOnlyLayout,
  artifactId: string
): Promise<LoadedWorkflowArtifactLifecycleRecord | null> {
  const chainToken = artifactChainToken(artifactId);
  const loaded = await loadFromChainToken(layout, chainToken);
  if (loaded && loaded.record.artifactId !== artifactId) {
    throw new Error("Workflow Artifact Lifecycle artifactId 不匹配");
  }
  return loaded;
}

async function loadFromChainToken(
  layout: DurableAppendOnlyLayout,
  chainToken: string
): Promise<LoadedWorkflowArtifactLifecycleRecord | null> {
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  const entries = await readdir(chainRootPath, { withFileTypes: true }).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  );
  if (!entries) return null;
  const ordered = entries
    .map((entry) => {
      const match = entry.name.match(ENTRY_PATTERN);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `Workflow Artifact Lifecycle chain 含未知项：${entry.name}`
        );
      }
      return { name: entry.name, revision: Number(match[1]) };
    })
    .sort((left, right) => left.revision - right.revision);
  if (!ordered.length || ordered.length > MAX_REVISIONS) {
    throw new Error("Workflow Artifact Lifecycle chain 长度非法");
  }
  const chain: WorkflowArtifactLifecycleRecordV1[] = [];
  let artifactId: string | null = null;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (entry.revision !== index || entry.name !== entryName(index)) {
      throw new Error("Workflow Artifact Lifecycle revision 不连续");
    }
    const read = await readDurableRegularFile(
      path.join(chainRootPath, entry.name),
      MAX_RECORD_BYTES,
      [1, 2]
    );
    const record = parseWorkflowArtifactLifecycleRecord(
      JSON.parse(read.content.toString("utf8")) as unknown
    );
    if (artifactId === null) {
      artifactId = record.artifactId;
      if (artifactChainToken(artifactId) !== chainToken) {
        throw new Error(
          "Workflow Artifact Lifecycle chain token 与 artifactId 不匹配"
        );
      }
    } else if (record.artifactId !== artifactId) {
      throw new Error("Workflow Artifact Lifecycle artifactId 已变化");
    }
    if (index > 0) {
      const previous = chain[index - 1];
      if (
        record.previousRevision !== previous.revision
        || record.previousDigest !== previous.digest
        || record.artifactKind !== previous.artifactKind
        || stableRecordMutationStringify(record.sourceConversationIds)
          !== stableRecordMutationStringify(previous.sourceConversationIds)
      ) {
        throw new Error("Workflow Artifact Lifecycle immutable fields 已变化");
      }
    }
    chain.push(record);
  }
  return {
    rootPath: layout.storageRootPath,
    chainToken,
    chain,
    record: chain[chain.length - 1]
  };
}

async function scanWorkflowArtifactLifecycleRecords(
  rootPath: string
): Promise<{
  records: WorkflowArtifactLifecycleRecordV1[];
  snapshotDigest: string;
}> {
  const rootStat = await lstatOrNull(rootPath);
  if (!rootStat) {
    return {
      records: [],
      snapshotDigest: recordMutationDigest({ records: [] })
    };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Workflow Artifact Lifecycle root 不是普通目录");
  }
  const canonicalRoot = await resolveDurablePlainRoot(
    rootPath,
    "Workflow Artifact Lifecycle root"
  );
  const rootEntries = await readdir(canonicalRoot, {
    withFileTypes: true
  });
  if (!rootEntries.length) {
    return {
      records: [],
      snapshotDigest: recordMutationDigest({ records: [] })
    };
  }
  if (
    rootEntries.length !== 1
    || rootEntries[0].name !== ARTIFACT_LIFECYCLE_NAMESPACE
    || !rootEntries[0].isDirectory()
    || rootEntries[0].isSymbolicLink()
  ) {
    throw new Error(
      "Workflow Artifact Lifecycle root 含未知项"
    );
  }
  const layout = await requireLayout(canonicalRoot, false);
  if (!layout) {
    throw new Error("Workflow Artifact Lifecycle namespace 缺失");
  }
  const namespaceEntries = await readdir(layout.namespaceRootPath, {
    withFileTypes: true
  });
  const stagingEntry = namespaceEntries.find(
    (entry) => entry.name === ".staging"
  );
  if (
    !stagingEntry
    || !stagingEntry.isDirectory()
    || stagingEntry.isSymbolicLink()
  ) {
    throw new Error(
      "Workflow Artifact Lifecycle staging 目录缺失或不安全"
    );
  }
  if ((await readdir(layout.stagingRootPath)).length) {
    throw new Error(
      "Workflow Artifact Lifecycle staging 含未收口数据"
    );
  }
  const chainEntries = namespaceEntries
    .filter((entry) => entry.name !== ".staging")
    .sort((left, right) => left.name.localeCompare(right.name));
  const records: WorkflowArtifactLifecycleRecordV1[] = [];
  for (const entry of chainEntries) {
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || !/^artifact-[a-f0-9]{24}$/.test(entry.name)
    ) {
      throw new Error(
        `Workflow Artifact Lifecycle namespace 含未知项：${entry.name}`
      );
    }
    const loaded = await loadFromChainToken(layout, entry.name);
    if (!loaded) {
      throw new Error(
        `Workflow Artifact Lifecycle chain 缺失：${entry.name}`
      );
    }
    records.push(cloneArtifactLifecycleRecord(loaded.record));
  }
  records.sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId)
  );
  return {
    records,
    snapshotDigest: recordMutationDigest({ records })
  };
}

function cloneArtifactLifecycleRecord(
  record: WorkflowArtifactLifecycleRecordV1
): WorkflowArtifactLifecycleRecordV1 {
  return {
    ...record,
    sourceConversationIds: [...record.sourceConversationIds],
    sourceDeletions: record.sourceDeletions.map((marker) => ({ ...marker }))
  };
}

async function lstatOrNull(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function artifactSourceDeletionReceipt(
  artifactId: string,
  marker: ArtifactSourceDeletionV1,
  phase: "source-deleted" | "source-restored"
): RecordMutationSourceParticipantReceipt {
  if (
    phase === "source-restored"
    && (
      marker.restoredAt === undefined
      || marker.restoreEffectId === undefined
    )
  ) {
    throw new Error("Workflow Artifact source restore marker 不完整");
  }
  const effect = phase === "source-deleted"
    ? {
        kind: "artifact-source-deletion",
        artifactId,
        mutationId: marker.mutationId,
        conversationId: marker.conversationId,
        deletedAt: marker.deletedAt,
        effectId: marker.forwardEffectId
      }
    : {
        kind: "artifact-source-restoration",
        artifactId,
        mutationId: marker.mutationId,
        conversationId: marker.conversationId,
        deletedAt: marker.deletedAt,
        forwardEffectId: marker.forwardEffectId,
        restoredAt: marker.restoredAt,
        effectId: marker.restoreEffectId
      };
  return createRecordMutationSourceParticipantReceipt({
    mutationId: marker.mutationId,
    conversationId: marker.conversationId,
    participantId: artifactId,
    recordKind: "artifact",
    phase,
    effectId: phase === "source-deleted"
      ? marker.forwardEffectId
      : marker.restoreEffectId!,
    effectDigest: recordMutationDigest(effect),
    occurredAt: phase === "source-deleted"
      ? marker.deletedAt
      : marker.restoredAt!
  });
}

async function requireLayout(
  rootPath: string,
  create: boolean
): Promise<DurableAppendOnlyLayout | null> {
  return await resolveDurableAppendOnlyLayout(
    rootPath,
    ARTIFACT_LIFECYCLE_NAMESPACE,
    create
  );
}

function artifactChainToken(artifactId: string): string {
  requireSafeId(artifactId, "artifactId");
  return `artifact-${createHash("sha256")
    .update(artifactId, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function entryName(revision: number): string {
  return `${ENTRY_PREFIX}${String(revision).padStart(ENTRY_WIDTH, "0")}.json`;
}

function recordBytes(record: WorkflowArtifactLifecycleRecordV1): Buffer {
  return Buffer.from(`${stableRecordMutationStringify(record)}\n`, "utf8");
}

function requireArtifactKind(value: unknown): WorkflowArtifactKind {
  if (
    value !== "markdown-report"
    && value !== "ui-card"
    && value !== "tracker"
    && value !== "history"
    && value !== "wiki"
    && value !== "editor-change"
    && value !== "other"
  ) {
    throw new Error("Workflow Artifact kind 非法");
  }
  return value;
}

function requireSafeId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_ID_PATTERN.test(value)
    || value !== value.normalize("NFC")
  ) {
    throw new Error(`Workflow Artifact ${label} 非法`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Workflow Artifact ${label} 非法`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Workflow Artifact ${label} 非法`);
  }
  return Number(value);
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`Workflow Artifact ${label} 非法`);
  }
  return Number(value);
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`Workflow Artifact ${label} 必须是 plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`Workflow Artifact ${label} 字段集合非法`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function withArtifactMutation<T>(
  rootPathInput: string,
  artifactIdInput: string,
  action: () => Promise<T>
): Promise<T> {
  const rootPath = path.resolve(rootPathInput);
  const artifactId = requireSafeId(artifactIdInput, "artifactId");
  const key = `${rootPath}\0${artifactId}`;
  const previous = artifactMutationTails.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(action);
  const tail = operation.then(() => undefined, () => undefined);
  artifactMutationTails.set(key, tail);
  try {
    return await operation;
  } finally {
    if (artifactMutationTails.get(key) === tail) {
      artifactMutationTails.delete(key);
    }
  }
}
