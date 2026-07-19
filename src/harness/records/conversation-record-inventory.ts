import { lstat, readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  inventoryWorkflowArtifactsByConversation,
  type WorkflowArtifactLifecycleRecordV1
} from "../artifacts/artifact-lifecycle-store";
import {
  canonicalRunRecordDigest,
  type WorkflowArtifactKind
} from "../contracts/run-record";
import {
  FileRunRecordStore,
  type ConversationRunRecordInventory
} from "../ledger/run-record-store";
import {
  readExistingEchoInkMemoryV2Snapshot,
  type ExistingEchoInkMemoryV2Snapshot,
  type MemoryProjectionRecordV2
} from "../memory/v2-store";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  echoInkRecordMutationRootPath
} from "../lifecycle/record-mutation-production";
import {
  pluginDataDir,
  rawStorageDir
} from "../../core/raw-message-store";
import type {
  ChatMessage,
  StoredSession
} from "../../settings/settings";

export type ConversationRecordInventoryBlockerCode =
  | "artifact-decision-stale"
  | "artifact-disposition-required"
  | "artifact-inventory-corrupt"
  | "artifact-source-already-deleted"
  | "memory-confirmation-disposition-required"
  | "memory-decision-stale"
  | "memory-inventory-corrupt"
  | "memory-pending-event"
  | "memory-source-already-deleted"
  | "memory-transaction-unresolved"
  | "raw-inventory-corrupt"
  | "raw-owner-inventory-incomplete"
  | "raw-reference-missing"
  | "run-inventory-corrupt"
  | `run-${ConversationRunRecordInventory["blockers"][number]["code"]}`;

export interface ConversationRecordInventoryBlocker {
  code: ConversationRecordInventoryBlockerCode;
  subjectId: string;
}

export interface ConversationMemoryInventorySubject {
  memoryId: string;
  state: "formal" | "confirmation";
  action: "mark-source-deleted" | "requires-explicit-choice";
}

export interface ConversationArtifactInventorySubject {
  artifactId: string;
  artifactKind: WorkflowArtifactKind;
  action: "mark-source-deleted" | "requires-explicit-choice";
}

export interface ConversationRawOwner {
  kind: "conversation-message" | "workflow-run-payload";
  ownerId: string;
  conversationId?: string;
}

export interface ConversationRawInventorySubject {
  rawRef: string;
  sourceRelativePath: string;
  action: "discard" | "retain";
  owners: ConversationRawOwner[];
}

export interface ConversationRecordInventory {
  operation: "clear-conversation-records" | "delete-conversation";
  conversationId: string;
  status: "ready" | "blocked";
  run: ConversationRunRecordInventory | null;
  memory: {
    storeState: ExistingEchoInkMemoryV2Snapshot["state"];
    snapshotDigest: string | null;
    subjects: ConversationMemoryInventorySubject[];
  } | null;
  artifacts: {
    snapshotDigest: string;
    subjects: ConversationArtifactInventorySubject[];
  } | null;
  raw: {
    snapshotDigest: string;
    subjects: ConversationRawInventorySubject[];
  } | null;
  blockers: ConversationRecordInventoryBlocker[];
  snapshotDigest: string;
}

export interface InventoryConversationRecordsInput {
  operation: "clear-conversation-records" | "delete-conversation";
  conversationId: string;
  conversations: readonly StoredSession[];
  vaultPath: string;
  pluginDir: string;
  decisions?: {
    retainMemoryIds?: readonly string[];
    retainArtifactIds?: readonly string[];
  };
}

interface RawStoreSnapshot {
  files: Array<{
    rawRef: string;
    sourceRelativePath: string;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }>;
  snapshotDigest: string;
}

/**
 * Builds the read-only, fail-closed selection input for a destructive
 * Conversation mutation. The returned snapshot is metadata-only: it never
 * includes message bodies, Run event bodies, Memory statements or absolute
 * filesystem paths.
 */
export async function inventoryConversationRecords(
  input: InventoryConversationRecordsInput
): Promise<ConversationRecordInventory> {
  if (
    input.operation !== "clear-conversation-records"
    && input.operation !== "delete-conversation"
  ) {
    throw new Error("Conversation inventory operation is invalid");
  }
  const conversationId = requireSafeIdentity(
    input.conversationId,
    "conversationId"
  );
  const conversations = validateConversationSet(
    input.conversations,
    conversationId
  );
  const vaultPath = requireAbsolutePath(input.vaultPath, "vaultPath");
  const pluginDir = requirePluginDir(input.pluginDir);
  const storageRootPath = pluginDataDir(vaultPath, pluginDir);
  const runStore = new FileRunRecordStore({ storageRootPath });
  const artifactRootPath = echoInkRecordMutationRootPath({
    vaultPath,
    pluginDir,
    rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.artifact
  });
  const blockers: ConversationRecordInventoryBlocker[] = [];

  const [runSettled, memorySettled, artifactSettled] =
    await Promise.allSettled([
      runStore.inventoryConversationRunRecords(conversationId),
      readExistingEchoInkMemoryV2Snapshot(vaultPath),
      inventoryWorkflowArtifactsByConversation(
        artifactRootPath,
        conversationId
      )
    ]);

  const run = runSettled.status === "fulfilled"
    ? runSettled.value
    : null;
  if (!run) {
    blockers.push({
      code: "run-inventory-corrupt",
      subjectId: conversationId
    });
  } else {
    for (const blocker of run.blockers) {
      blockers.push({
        code: `run-${blocker.code}`,
        subjectId: `${blocker.workflowRunId}:${blocker.attemptId}`
      });
    }
  }

  const memorySnapshot = memorySettled.status === "fulfilled"
    ? memorySettled.value
    : null;
  const memory = memorySnapshot
    ? buildConversationMemoryInventory(
        memorySnapshot,
        conversationId,
        input.decisions?.retainMemoryIds ?? [],
        blockers
      )
    : null;
  if (!memory) {
    blockers.push({
      code: "memory-inventory-corrupt",
      subjectId: conversationId
    });
  }

  const artifactSnapshot = artifactSettled.status === "fulfilled"
    ? artifactSettled.value
    : null;
  const artifacts = artifactSnapshot
    ? buildConversationArtifactInventory(
        artifactSnapshot.artifacts,
        artifactSnapshot.snapshotDigest,
        conversationId,
        input.decisions?.retainArtifactIds ?? [],
        blockers
      )
    : null;
  if (!artifacts) {
    blockers.push({
      code: "artifact-inventory-corrupt",
      subjectId: conversationId
    });
  }

  let raw: ConversationRecordInventory["raw"] = null;
  if (!run) {
    blockers.push({
      code: "raw-owner-inventory-incomplete",
      subjectId: conversationId
    });
  } else {
    try {
      raw = await buildConversationRawInventory({
        vaultPath,
        pluginDir,
        conversationId,
        conversations,
        run,
        blockers
      });
    } catch {
      blockers.push({
        code: "raw-inventory-corrupt",
        subjectId: conversationId
      });
    }
  }

  blockers.sort(compareBlockers);
  const snapshotDigest = canonicalRunRecordDigest({
    operation: input.operation,
    conversationId,
    run: run?.snapshotDigest ?? null,
    memory: memory?.snapshotDigest ?? null,
    artifacts: artifacts?.snapshotDigest ?? null,
    raw: raw?.snapshotDigest ?? null,
    memorySubjects: memory?.subjects ?? null,
    artifactSubjects: artifacts?.subjects ?? null,
    rawSubjects: raw?.subjects ?? null,
    blockers
  });
  return {
    operation: input.operation,
    conversationId,
    status: blockers.length ? "blocked" : "ready",
    run,
    memory,
    artifacts,
    raw,
    blockers,
    snapshotDigest
  };
}

function buildConversationMemoryInventory(
  snapshot: ExistingEchoInkMemoryV2Snapshot,
  conversationId: string,
  retainMemoryIdsInput: readonly string[],
  blockers: ConversationRecordInventoryBlocker[]
): NonNullable<ConversationRecordInventory["memory"]> {
  if (snapshot.state === "missing") {
    return {
      storeState: "missing",
      snapshotDigest: null,
      subjects: []
    };
  }
  const retainMemoryIds = new Set(
    normalizeDecisionIds(retainMemoryIdsInput, "retainMemoryId")
  );
  const subjects: ConversationMemoryInventorySubject[] = [];
  const choiceEligibleIds = new Set<string>();
  for (const memory of snapshot.index.memories) {
    if (!memory.sourceConversationIds?.includes(conversationId)) continue;
    const activeDeletion = activeSourceDeletion(
      memory.sourceDeletions,
      conversationId
    );
    if (activeDeletion) {
      blockers.push({
        code: "memory-source-already-deleted",
        subjectId: memory.id
      });
    }
    subjects.push({
      memoryId: memory.id,
      state: "formal",
      action: "mark-source-deleted"
    });
  }
  for (const value of snapshot.index.confirmations) {
    const confirmation = value as {
      id: string;
      candidate: MemoryProjectionRecordV2;
    };
    if (
      !confirmation.candidate.sourceConversationIds?.includes(conversationId)
    ) {
      continue;
    }
    const activeDeletion = activeSourceDeletion(
      confirmation.candidate.sourceDeletions,
      conversationId
    );
    if (activeDeletion) {
      blockers.push({
        code: "memory-source-already-deleted",
        subjectId: confirmation.id
      });
    }
    const retained = retainMemoryIds.has(confirmation.id);
    choiceEligibleIds.add(confirmation.id);
    subjects.push({
      memoryId: confirmation.id,
      state: "confirmation",
      action: retained
        ? "mark-source-deleted"
        : "requires-explicit-choice"
    });
    if (!retained) {
      blockers.push({
        code: "memory-confirmation-disposition-required",
        subjectId: confirmation.id
      });
    }
  }
  for (const memoryId of retainMemoryIds) {
    if (!choiceEligibleIds.has(memoryId)) {
      blockers.push({
        code: "memory-decision-stale",
        subjectId: memoryId
      });
    }
  }
  for (const event of snapshot.pendingEvents) {
    if (event.sessionId === conversationId) {
      blockers.push({
        code: "memory-pending-event",
        subjectId: event.eventId
      });
    }
  }
  for (const transaction of snapshot.transactions) {
    const settled = transaction.state === "committed"
      || (
        transaction.state === "recovered"
        && transaction.outcome !== "pending"
      );
    if (!settled) {
      blockers.push({
        code: "memory-transaction-unresolved",
        subjectId: transaction.transactionId
      });
    }
  }
  subjects.sort((left, right) => (
    left.memoryId.localeCompare(right.memoryId)
    || left.state.localeCompare(right.state)
  ));
  return {
    storeState: "present",
    snapshotDigest: snapshot.snapshotDigest,
    subjects
  };
}

function buildConversationArtifactInventory(
  records: readonly WorkflowArtifactLifecycleRecordV1[],
  snapshotDigest: string,
  conversationId: string,
  retainArtifactIdsInput: readonly string[],
  blockers: ConversationRecordInventoryBlocker[]
): NonNullable<ConversationRecordInventory["artifacts"]> {
  const retainArtifactIds = new Set(
    normalizeDecisionIds(retainArtifactIdsInput, "retainArtifactId")
  );
  const targetArtifactIds = new Set(
    records.map((record) => record.artifactId)
  );
  const subjects = records.map((record) => {
    if (activeSourceDeletion(record.sourceDeletions, conversationId)) {
      blockers.push({
        code: "artifact-source-already-deleted",
        subjectId: record.artifactId
      });
    }
    const retained = retainArtifactIds.has(record.artifactId);
    if (!retained) {
      blockers.push({
        code: "artifact-disposition-required",
        subjectId: record.artifactId
      });
    }
    return {
      artifactId: record.artifactId,
      artifactKind: record.artifactKind,
      action: retained
        ? "mark-source-deleted" as const
        : "requires-explicit-choice" as const
    };
  }).sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId)
  );
  for (const artifactId of retainArtifactIds) {
    if (!targetArtifactIds.has(artifactId)) {
      blockers.push({
        code: "artifact-decision-stale",
        subjectId: artifactId
      });
    }
  }
  return { snapshotDigest, subjects };
}

async function buildConversationRawInventory(input: {
  vaultPath: string;
  pluginDir: string;
  conversationId: string;
  conversations: readonly StoredSession[];
  run: ConversationRunRecordInventory;
  blockers: ConversationRecordInventoryBlocker[];
}): Promise<NonNullable<ConversationRecordInventory["raw"]>> {
  const ownersByRef = new Map<string, ConversationRawOwner[]>();
  for (const conversation of input.conversations) {
    for (const message of conversation.messages) {
      if (!message.rawRef) continue;
      addRawOwner(
        ownersByRef,
        normalizeRawRef(message.rawRef),
        conversationMessageOwner(conversation.id, message)
      );
    }
  }
  for (const owner of input.run.storeRawOwners) {
    addRawOwner(ownersByRef, owner.rawRef, {
      kind: "workflow-run-payload",
      ownerId: `${owner.workflowRunId}:${owner.attemptId}`,
      ...(owner.conversationId
        ? { conversationId: owner.conversationId }
        : {})
    });
  }

  const storeSnapshot = await scanRawStore(
    rawStorageDir(input.vaultPath, input.pluginDir)
  );
  const fileByRef = new Map(
    storeSnapshot.files.map((file) => [file.rawRef, file])
  );
  const subjects: ConversationRawInventorySubject[] = [];
  for (const [rawRef, owners] of [...ownersByRef.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const targetOwned = owners.some(
      (owner) => owner.conversationId === input.conversationId
    );
    if (!targetOwned) continue;
    const file = fileByRef.get(rawRef);
    if (!file) {
      input.blockers.push({
        code: "raw-reference-missing",
        subjectId: rawRef
      });
      continue;
    }
    const shared = owners.some(
      (owner) => owner.conversationId !== input.conversationId
    );
    subjects.push({
      rawRef,
      sourceRelativePath: file.sourceRelativePath,
      action: shared ? "retain" : "discard",
      owners: [...owners].sort(compareRawOwners)
    });
  }
  return {
    snapshotDigest: canonicalRunRecordDigest({
      storeSnapshotDigest: storeSnapshot.snapshotDigest,
      owners: [...ownersByRef.entries()].sort(
        ([left], [right]) => left.localeCompare(right)
      ),
      subjects
    }),
    subjects
  };
}

async function scanRawStore(rootPath: string): Promise<RawStoreSnapshot> {
  const before = await scanRawStoreOnce(rootPath);
  const after = await scanRawStoreOnce(rootPath);
  if (after.snapshotDigest !== before.snapshotDigest) {
    throw new Error("Raw Store changed during Conversation inventory");
  }
  return before;
}

async function scanRawStoreOnce(rootPath: string): Promise<RawStoreSnapshot> {
  const rootStats = await lstatOrNull(rootPath);
  if (!rootStats) {
    return rawStoreSnapshot([]);
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Raw Store root is not a plain directory");
  }
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: RawStoreSnapshot["files"] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || !/^[a-zA-Z0-9_.-]{1,160}\.txt$/.test(entry.name)
      || entry.name.includes("..")
    ) {
      throw new Error(`Raw Store contains unsafe entry ${entry.name}`);
    }
    const absolutePath = path.join(rootPath, entry.name);
    const stats = await lstat(absolutePath);
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.nlink !== 1
    ) {
      throw new Error(`Raw Store entry ${entry.name} is unsafe`);
    }
    files.push({
      rawRef: `raw/${entry.name}`,
      sourceRelativePath: entry.name,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs
    });
  }
  return rawStoreSnapshot(files);
}

function rawStoreSnapshot(
  filesInput: RawStoreSnapshot["files"]
): RawStoreSnapshot {
  const files = [...filesInput].sort((left, right) =>
    left.rawRef.localeCompare(right.rawRef)
  );
  return {
    files,
    snapshotDigest: canonicalRunRecordDigest({ files })
  };
}

function validateConversationSet(
  conversationsInput: readonly StoredSession[],
  targetConversationId: string
): StoredSession[] {
  const ids = new Set<string>();
  const conversations = conversationsInput.map((conversation) => {
    const id = requireSafeIdentity(conversation.id, "session.id");
    if (ids.has(id)) {
      throw new Error(`Conversation inventory has duplicate session ${id}`);
    }
    ids.add(id);
    if (!Array.isArray(conversation.messages)) {
      throw new Error(`Conversation ${id} messages are invalid`);
    }
    const messageIds = new Set<string>();
    for (const message of conversation.messages) {
      const messageId = requireSafeIdentity(message.id, "message.id");
      if (messageIds.has(messageId)) {
        throw new Error(
          `Conversation ${id} has duplicate message ${messageId}`
        );
      }
      messageIds.add(messageId);
    }
    return conversation;
  });
  if (!ids.has(targetConversationId)) {
    throw new Error(
      `Conversation inventory target ${targetConversationId} is missing`
    );
  }
  return conversations;
}

function conversationMessageOwner(
  conversationId: string,
  message: ChatMessage
): ConversationRawOwner {
  return {
    kind: "conversation-message",
    ownerId: `${conversationId}:${requireSafeIdentity(
      message.id,
      "message.id"
    )}`,
    conversationId
  };
}

function addRawOwner(
  ownersByRef: Map<string, ConversationRawOwner[]>,
  rawRefInput: string,
  owner: ConversationRawOwner
): void {
  const rawRef = normalizeRawRef(rawRefInput);
  const owners = ownersByRef.get(rawRef) ?? [];
  if (!owners.some((candidate) =>
    candidate.kind === owner.kind
    && candidate.ownerId === owner.ownerId
  )) {
    owners.push(owner);
  }
  ownersByRef.set(rawRef, owners);
}

function compareRawOwners(
  left: ConversationRawOwner,
  right: ConversationRawOwner
): number {
  return left.kind.localeCompare(right.kind)
    || left.ownerId.localeCompare(right.ownerId);
}

function compareBlockers(
  left: ConversationRecordInventoryBlocker,
  right: ConversationRecordInventoryBlocker
): number {
  return left.code.localeCompare(right.code)
    || left.subjectId.localeCompare(right.subjectId);
}

function activeSourceDeletion(
  markers: Array<{
    conversationId: string;
    restoredAt?: number;
  }> | undefined,
  conversationId: string
): boolean {
  return Boolean(markers?.some((marker) =>
    marker.conversationId === conversationId
    && marker.restoredAt === undefined
  ));
}

function normalizeDecisionIds(
  values: readonly string[],
  label: string
): string[] {
  const ids = values.map((value) => requireSafeIdentity(value, label));
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  if (
    new Set(ids).size !== ids.length
    || ids.some((id, index) => id !== sorted[index])
  ) {
    throw new Error(`${label} values must be unique and sorted`);
  }
  return ids;
}

function normalizeRawRef(value: string): string {
  if (
    value !== value.trim()
    || value.includes("\\")
    || value.includes("..")
    || !/^raw\/[a-zA-Z0-9_.-]{1,160}\.txt$/.test(value)
  ) {
    throw new Error("Conversation inventory contains an unsafe rawRef");
  }
  return value;
}

function requireSafeIdentity(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > 320
    || containsUnsafeControlCharacter(value)
  ) {
    throw new Error(`Conversation inventory ${label} is invalid`);
  }
  return value;
}

function requirePluginDir(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    !normalized
    || normalized.split("/").includes("..")
    || containsUnsafeControlCharacter(normalized)
  ) {
    throw new Error("Conversation inventory pluginDir is invalid");
  }
  return normalized;
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value !== value.trim()
    || value.includes("\0")
  ) {
    throw new Error(`Conversation inventory ${label} is invalid`);
  }
  return path.resolve(value);
}

function containsUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

async function lstatOrNull(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
