import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  atomicWriteJson,
  atomicWriteText,
  echoInkMemoryV2Layout,
  initializeEchoInkMemoryV2,
  MAX_PENDING_MEMORY_EVENTS,
  readMemoryIndexV2,
  readMemoryManifestV2,
  readPendingMemoryEvents,
  replacePendingMemoryEvents,
  validateMemoryIndexV2,
  withMemoryFormalMutation,
  writeMemoryProjectionSet,
  type MemoryIndexV2,
  type PendingMemoryEvent
} from "./v2-store";
import { memoryWorkflowPolicy } from "./workflow-policy";

export type MemoryRecordKind = "current-state" | "preference" | "decision" | "constraint" | "open-loop" | "task-state" | "workflow-rule" | "lesson";
export type MemoryDisposition = "write" | "skip" | "unresolved";

const CURATOR_RESULT_KEYS = new Set(["schemaVersion", "outcome", "summary", "candidates"]);
const CURATOR_CANDIDATE_KEYS = new Set([
  "candidateId",
  "disposition",
  "sourceEventIds",
  "reason",
  "kind",
  "scope",
  "statement",
  "evidenceRefs",
  "sourceRunId",
  "confidence",
  "requiresConfirmation"
]);
const SAFE_MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_MEMORY_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@#=-]{0,319}$/;
const DANGEROUS_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CURATOR_MEMORY_KIND_IMPORTANCE: Record<MemoryRecordKind, number> = {
  constraint: 8,
  decision: 7,
  "workflow-rule": 6,
  preference: 5,
  lesson: 4,
  "current-state": 3,
  "open-loop": 2,
  "task-state": 1
};

export const MAX_CURATOR_ACTIVE_MEMORY_RECORDS = 64;
export const MAX_CURATOR_ACTIVE_MEMORY_SNAPSHOT_CHARS = 32_000;

export interface MemoryRecordV2 {
  id: string;
  kind: MemoryRecordKind;
  scope: string;
  statement: string;
  evidenceRefs: string[];
  sourceRunId: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  supersededAt?: number;
  supersededReason?: string;
  deletedAt?: number;
  deletedReason?: string;
  expiredAt?: number;
  expiresAt?: number;
}

export interface MemoryConfirmationV2 {
  id: string;
  candidate: Omit<MemoryRecordV2, "createdAt" | "updatedAt">;
  sourceEventIds: string[];
  reason: string;
  conflictsWith: string[];
  createdAt: number;
}

export interface MemoryCuratorCandidate {
  candidateId: string;
  disposition: MemoryDisposition;
  sourceEventIds: string[];
  reason: string;
  kind?: MemoryRecordKind;
  scope?: string;
  statement?: string;
  evidenceRefs?: string[];
  sourceRunId?: string;
  confidence?: number;
  requiresConfirmation?: boolean;
}

export interface MemoryCuratorResult {
  schemaVersion: 2;
  outcome: "write" | "no-op" | "pending";
  summary: string;
  candidates: MemoryCuratorCandidate[];
}

export interface MemoryCuratorRequest {
  transactionId: string;
  baseRevision: number;
  events: PendingMemoryEvent[];
  activeMemories: MemoryRecordV2[];
}

export interface MemoryCurator {
  curate(request: MemoryCuratorRequest): Promise<unknown>;
}

export interface MemoryCoverageReport {
  schemaVersion: 2;
  transactionId: string;
  complete: boolean;
  coveredEventIds: string[];
  missingEventIds: string[];
  unknownEventIds: string[];
  unresolvedCandidateIds: string[];
}

export interface MemorySyncResult {
  transactionId?: string;
  outcome: "no-pending" | "write" | "no-op" | "pending" | "failed";
  revision: number;
  committedMemoryIds: string[];
  confirmationIds: string[];
  error?: string;
}

type MemoryTransactionState = "prepared" | "applied" | "unresolved" | "invalid" | "failed" | "committing" | "committed" | "recovered";

interface MemoryTransactionRecord {
  schemaVersion: 2;
  transactionId: string;
  state: MemoryTransactionState;
  baseRevision: number;
  targetRevision: number;
  eventIds: string[];
  outcome: MemorySyncResult["outcome"];
  committedMemoryIds: string[];
  confirmationIds: string[];
  createdAt: number;
  updatedAt: number;
  error: string;
  operation?: string;
}

export interface MemoryTransactionIssue {
  transactionId: string;
  state: Exclude<MemoryTransactionState, "committed" | "recovered">;
  eventIds: string[];
  error: string;
  updatedAt: number;
}

interface MemoryTransactionSource extends MemoryCuratorRequest {
  schemaVersion: 2;
}

export async function prepareMemoryTransaction(vaultPath: string, eventIds?: string[]): Promise<MemoryCuratorRequest | null> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const manifest = await readMemoryManifestV2(vaultPath);
  const index = await readMemoryIndexV2<MemoryRecordV2>(vaultPath);
  const selectedIds = eventIds === undefined ? null : new Set(eventIds);
  const events = (await readPendingMemoryEvents(vaultPath)).filter((event) => !selectedIds || selectedIds.has(event.eventId));
  if (!events.length) return null;
  const transactionId = `memory-tx-${randomUUID()}`;
  const source: MemoryTransactionSource = {
    schemaVersion: 2,
    transactionId,
    baseRevision: manifest.revision,
    events,
    activeMemories: buildCuratorActiveMemorySnapshot(index.memories, Date.now())
  };
  const transaction = transactionRecord(source, Date.now());
  const dir = transactionDir(layout.transactions, transactionId);
  await mkdir(dir, { recursive: true });
  await atomicWriteJson(path.join(dir, "source.json"), source);
  await writeTransaction(layout.transactions, transaction);
  return source;
}

function buildCuratorActiveMemorySnapshot(memories: MemoryRecordV2[], now: number): MemoryRecordV2[] {
  const ordered = memories
    .filter((item) => isActive(item, now))
    .sort((left, right) => (
      right.updatedAt - left.updatedAt
      || CURATOR_MEMORY_KIND_IMPORTANCE[right.kind] - CURATOR_MEMORY_KIND_IMPORTANCE[left.kind]
      || right.confidence - left.confidence
      || compareStableIds(left.id, right.id)
    ));
  const selected: MemoryRecordV2[] = [];
  let serializedChars = 2; // JSON array brackets.
  for (const memory of ordered) {
    if (selected.length >= MAX_CURATOR_ACTIVE_MEMORY_RECORDS) break;
    const memoryChars = JSON.stringify(memory).length;
    const nextChars = serializedChars + (selected.length ? 1 : 0) + memoryChars;
    if (nextChars > MAX_CURATOR_ACTIVE_MEMORY_SNAPSHOT_CHARS) break;
    selected.push(memory);
    serializedChars = nextChars;
  }
  return selected;
}

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateMemoryCuratorResult(source: MemoryCuratorRequest, raw: unknown): {
  result: MemoryCuratorResult;
  coverage: MemoryCoverageReport;
} {
  const result = parseCuratorResult(raw);
  const expected = new Set(source.events.map((event) => event.eventId));
  const covered = new Set<string>();
  const unknown = new Set<string>();
  const unresolved: string[] = [];
  const candidateIds = new Set<string>();
  for (const candidate of result.candidates) {
    validateCandidate(candidate);
    if (candidateIds.has(candidate.candidateId)) throw new Error(`Duplicate memory candidate id: ${candidate.candidateId}`);
    candidateIds.add(candidate.candidateId);
    if (candidate.disposition === "unresolved") unresolved.push(candidate.candidateId);
    for (const eventId of candidate.sourceEventIds) {
      if (expected.has(eventId)) covered.add(eventId);
      else unknown.add(eventId);
    }
  }
  const missing = [...expected].filter((eventId) => !covered.has(eventId));
  const coverage: MemoryCoverageReport = {
    schemaVersion: 2,
    transactionId: source.transactionId,
    complete: missing.length === 0 && unknown.size === 0,
    coveredEventIds: [...covered],
    missingEventIds: missing,
    unknownEventIds: [...unknown],
    unresolvedCandidateIds: unresolved
  };
  if (!coverage.complete) throw new Error(`Invalid memory coverage: missing=${missing.join(",") || "none"}; unknown=${[...unknown].join(",") || "none"}`);
  if (result.outcome === "no-op" && result.candidates.some((candidate) => candidate.disposition !== "skip")) {
    throw new Error("Memory no-op result may only contain skip candidates");
  }
  if (result.outcome === "write" && !result.candidates.some((candidate) => candidate.disposition === "write")) {
    throw new Error("Memory write result must contain at least one write candidate");
  }
  if (unresolved.length && result.outcome !== "pending") throw new Error("Unresolved memory candidates require pending outcome");
  if (result.outcome === "pending" && !unresolved.length) throw new Error("Memory pending outcome requires at least one unresolved candidate");
  return { result, coverage };
}

export async function applyMemoryCuratorResult(vaultPath: string, transactionId: string, raw: unknown): Promise<MemorySyncResult> {
  return await withMemoryFormalMutation(vaultPath, async () => await applyMemoryCuratorResultUnlocked(vaultPath, transactionId, raw));
}

async function applyMemoryCuratorResultUnlocked(vaultPath: string, transactionId: string, raw: unknown): Promise<MemorySyncResult> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const transaction = await readTransaction(layout.transactions, transactionId);
  const source = await readJson<MemoryTransactionSource>(path.join(transactionDir(layout.transactions, transactionId), "source.json"));
  try {
    const validated = validateMemoryCuratorResult(source, raw);
    await atomicWriteJson(path.join(transactionDir(layout.transactions, transactionId), "curator-result.json"), validated.result);
    await atomicWriteJson(path.join(transactionDir(layout.transactions, transactionId), "coverage-report.json"), validated.coverage);
    if (validated.coverage.unresolvedCandidateIds.length) {
      const unresolved = updateTransaction(transaction, {
        state: "unresolved",
        outcome: "pending",
        error: `Unresolved candidates: ${validated.coverage.unresolvedCandidateIds.join(", ")}`
      });
      await writeTransaction(layout.transactions, unresolved);
      await writeManifestOutcome(vaultPath, "pending", unresolved.error);
      return syncResult(unresolved);
    }
    const index = await readMemoryIndexV2<MemoryRecordV2>(vaultPath);
    if (index.revision !== transaction.baseRevision) throw new Error(`Memory revision changed from ${transaction.baseRevision} to ${index.revision}`);
    const staged = buildStagedIndex(index, validated.result, source.events, Date.now());
    const changed = JSON.stringify({ memories: index.memories, confirmations: index.confirmations }) !== JSON.stringify({ memories: staged.index.memories, confirmations: staged.index.confirmations });
    const outcome: MemorySyncResult["outcome"] = changed ? "write" : "no-op";
    const targetRevision = changed ? transaction.baseRevision + 1 : transaction.baseRevision;
    staged.index.revision = targetRevision;
    if (changed) staged.index.commitId = transactionId;
    const dir = transactionDir(layout.transactions, transactionId);
    await mkdir(path.join(dir, "staged"), { recursive: true });
    await atomicWriteJson(path.join(dir, "staged", "index.json"), staged.index);
    await writeMemoryProjectionSet(path.join(dir, "staged"), staged.index.memories, Date.now());
    const applied = updateTransaction(transaction, {
      state: "applied",
      targetRevision,
      outcome,
      committedMemoryIds: staged.committedMemoryIds,
      confirmationIds: staged.confirmationIds,
      error: ""
    });
    await writeTransaction(layout.transactions, applied);
    return syncResult(applied);
  } catch (error) {
    const invalid = updateTransaction(transaction, {
      state: "invalid",
      outcome: "failed",
      error: errorMessage(error)
    });
    await writeTransaction(layout.transactions, invalid);
    await writeManifestOutcome(vaultPath, "failed", invalid.error);
    return syncResult(invalid);
  }
}

export async function commitMemoryTransaction(
  vaultPath: string,
  transactionId: string,
  options: { failAfterIndexWrite?: boolean; beforeIndexWrite?: () => Promise<void> } = {}
): Promise<MemorySyncResult> {
  return await withMemoryFormalMutation(vaultPath, async () => {
    await recoverMemoryTransactionsUnlocked(vaultPath);
    return await commitMemoryTransactionUnlocked(vaultPath, transactionId, options);
  });
}

async function commitMemoryTransactionUnlocked(
  vaultPath: string,
  transactionId: string,
  options: { failAfterIndexWrite?: boolean; beforeIndexWrite?: () => Promise<void> } = {}
): Promise<MemorySyncResult> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  let transaction = await readTransaction(layout.transactions, transactionId);
  if (transaction.state !== "applied") return syncResult(transaction);
  const manifest = await readMemoryManifestV2(vaultPath);
  if (manifest.revision !== transaction.baseRevision) {
    transaction = updateTransaction(transaction, { state: "failed", outcome: "failed", error: "Memory base revision no longer matches" });
    await writeTransaction(layout.transactions, transaction);
    return syncResult(transaction);
  }
  transaction = updateTransaction(transaction, { state: "committing" });
  await writeTransaction(layout.transactions, transaction);
  const dir = transactionDir(layout.transactions, transactionId);
  const backupDir = path.join(dir, "backups");
  await mkdir(backupDir, { recursive: true });
  for (const file of formalFiles(layout)) {
    if (await pathExists(file)) await copyFile(file, path.join(backupDir, backupName(layout.root, file)));
  }
  try {
    if (transaction.outcome === "write") {
      await options.beforeIndexWrite?.();
      await atomicWriteText(layout.index, await readFile(path.join(dir, "staged", "index.json"), "utf8"));
      if (options.failAfterIndexWrite) throw new Error("Injected failure after index write");
      await installProjectionSet(layout, path.join(dir, "staged"));
    }
    await atomicWriteJson(layout.manifest, {
      ...manifest,
      revision: transaction.targetRevision,
      lastSyncAt: Date.now(),
      lastOutcome: transaction.outcome,
      lastError: ""
    });
    await removeCommittedEvents(vaultPath, transaction.eventIds);
    transaction = updateTransaction(transaction, { state: "committed" });
    await writeTransaction(layout.transactions, transaction);
    await appendAudit(layout.audit, transaction, transaction.outcome);
    return syncResult(transaction);
  } catch (error) {
    transaction = updateTransaction(transaction, { error: errorMessage(error) });
    await writeTransaction(layout.transactions, transaction);
    await writeManifestOutcome(vaultPath, "failed", transaction.error);
    return { ...syncResult(transaction), outcome: "failed", error: errorMessage(error) };
  }
}

export async function commitFormalMemoryIndexSnapshot(
  vaultPath: string,
  index: MemoryIndexV2<MemoryRecordV2>,
  now: number,
  options: { operation: string; lockHeld: true; failAfterIndexWrite?: boolean }
): Promise<boolean> {
  if (options.lockHeld !== true) throw new Error("Formal memory commit requires the vault mutation lane");
  await recoverMemoryTransactionsUnlocked(vaultPath);
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const manifest = await readMemoryManifestV2(vaultPath);
  const previous = await readMemoryIndexV2<MemoryRecordV2>(vaultPath);
  if (manifest.revision !== previous.revision) {
    throw new Error(`EchoInk Memory recovery required: manifest revision ${manifest.revision} does not match index revision ${previous.revision}`);
  }
  if (index.revision !== previous.revision) {
    throw new Error(`EchoInk Memory changed from revision ${index.revision} to ${previous.revision}`);
  }
  const changed = JSON.stringify({ memories: previous.memories, confirmations: previous.confirmations }) !== JSON.stringify({ memories: index.memories, confirmations: index.confirmations });
  if (!changed) return false;

  const transactionId = `memory-formal-${randomUUID()}`;
  const targetRevision = previous.revision + 1;
  index.revision = targetRevision;
  index.commitId = transactionId;
  validateMemoryIndexV2(index);
  const transaction: MemoryTransactionRecord = {
    schemaVersion: 2,
    transactionId,
    state: "prepared",
    baseRevision: previous.revision,
    targetRevision,
    eventIds: [],
    outcome: "write",
    committedMemoryIds: [],
    confirmationIds: [],
    createdAt: now,
    updatedAt: now,
    error: "",
    operation: options.operation
  };
  const dir = transactionDir(layout.transactions, transactionId);
  const stagedDir = path.join(dir, "staged");
  const backupDir = path.join(dir, "backups");
  await mkdir(stagedDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await atomicWriteJson(path.join(stagedDir, "index.json"), index);
  await writeMemoryProjectionSet(stagedDir, index.memories, now);
  for (const file of formalFiles(layout)) {
    if (await pathExists(file)) await copyFile(file, path.join(backupDir, backupName(layout.root, file)));
  }
  await writeTransaction(layout.transactions, updateTransaction(transaction, { state: "committing" }));
  try {
    await atomicWriteText(layout.index, await readFile(path.join(stagedDir, "index.json"), "utf8"));
    if (options.failAfterIndexWrite) throw new Error(`Injected failure after index write for ${options.operation}`);
    await installProjectionSet(layout, stagedDir);
    await atomicWriteJson(layout.manifest, {
      ...manifest,
      revision: targetRevision,
      lastSyncAt: now,
      lastOutcome: "write",
      lastError: ""
    });
    const committed = updateTransaction(transaction, { state: "committed", updatedAt: now });
    await writeTransaction(layout.transactions, committed);
    await appendAudit(layout.audit, committed, options.operation);
    return true;
  } catch (error) {
    const interrupted = updateTransaction(transaction, { state: "committing", error: errorMessage(error) });
    await writeTransaction(layout.transactions, interrupted);
    await writeManifestOutcome(vaultPath, "failed", interrupted.error);
    throw error;
  }
}

export async function syncPendingMemory(
  vaultPath: string,
  curator: MemoryCurator,
  eventIds?: string[]
): Promise<MemorySyncResult> {
  return await withMemoryFormalMutation(vaultPath, async () => await syncPendingMemoryUnlocked(vaultPath, curator, eventIds));
}

async function syncPendingMemoryUnlocked(
  vaultPath: string,
  curator: MemoryCurator,
  eventIds?: string[]
): Promise<MemorySyncResult> {
  await recoverMemoryTransactionsUnlocked(vaultPath);
  const selectedEventIds = eventIds ?? await readyPendingMemoryEventIds(vaultPath);
  const source = await prepareMemoryTransaction(vaultPath, selectedEventIds);
  const manifest = await readMemoryManifestV2(vaultPath);
  if (!source) return { outcome: "no-pending", revision: manifest.revision, committedMemoryIds: [], confirmationIds: [] };
  try {
    const curated = await curator.curate(source);
    const applied = await applyMemoryCuratorResultUnlocked(vaultPath, source.transactionId, curated);
    if (applied.outcome === "failed" || applied.outcome === "pending") return applied;
    return await commitMemoryTransactionUnlocked(vaultPath, source.transactionId);
  } catch (error) {
    const layout = echoInkMemoryV2Layout(vaultPath);
    const transaction = await readTransaction(layout.transactions, source.transactionId);
    const failed = updateTransaction(transaction, { state: "failed", outcome: "failed", error: errorMessage(error) });
    await writeTransaction(layout.transactions, failed);
    await writeManifestOutcome(vaultPath, "failed", failed.error);
    return syncResult(failed);
  }
}

async function readyPendingMemoryEventIds(vaultPath: string): Promise<string[]> {
  const groups = new Map<string, PendingMemoryEvent[]>();
  for (const event of await readPendingMemoryEvents(vaultPath)) {
    const group = groups.get(event.runId) ?? [];
    group.push(event);
    groups.set(event.runId, group);
  }
  const ready: string[] = [];
  for (const events of groups.values()) {
    const requiresWorkflowResult = events.some((event) => memoryWorkflowPolicy(event.workflow).capture === "workflow-result");
    const readyType: PendingMemoryEvent["eventType"] = requiresWorkflowResult ? "workflow-result" : "final-result";
    if (!events.some((event) => event.eventType === readyType)) continue;
    ready.push(...events.map((event) => event.eventId));
  }
  return ready;
}

export async function recoverMemoryTransactions(vaultPath: string): Promise<Array<{ transactionId: string; action: "rolled-forward" | "rolled-back" | "retained" | "superseded" }>> {
  return await withMemoryFormalMutation(vaultPath, async () => await recoverMemoryTransactionsUnlocked(vaultPath));
}

async function recoverMemoryTransactionsUnlocked(vaultPath: string): Promise<Array<{ transactionId: string; action: "rolled-forward" | "rolled-back" | "retained" | "superseded" }>> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const results: Array<{ transactionId: string; action: "rolled-forward" | "rolled-back" | "retained" | "superseded" }> = [];
  for (const entry of await readdir(layout.transactions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transaction = await readTransaction(layout.transactions, entry.name).catch(() => null);
    if (!transaction || transaction.state === "committed" || transaction.state === "recovered") continue;
    if (transaction.state !== "committing") {
      results.push({ transactionId: transaction.transactionId, action: "retained" });
      continue;
    }
    const index = await readMemoryIndexV2<MemoryRecordV2>(vaultPath);
    if (transaction.outcome === "no-op" && index.revision === transaction.baseRevision) {
      const manifest = await readMemoryManifestV2(vaultPath);
      await atomicWriteJson(layout.manifest, {
        ...manifest,
        revision: transaction.baseRevision,
        lastSyncAt: Date.now(),
        lastOutcome: "no-op",
        lastError: ""
      });
      await removeCommittedEvents(vaultPath, transaction.eventIds);
      await writeTransaction(layout.transactions, updateTransaction(transaction, { state: "recovered", error: "" }));
      results.push({ transactionId: transaction.transactionId, action: "rolled-forward" });
      continue;
    }
    if (index.revision === transaction.targetRevision && index.commitId === transaction.transactionId) {
      await installProjectionSet(layout, path.join(transactionDir(layout.transactions, transaction.transactionId), "staged"));
      const manifest = await readMemoryManifestV2(vaultPath);
      await atomicWriteJson(layout.manifest, {
        ...manifest,
        revision: transaction.targetRevision,
        lastSyncAt: Date.now(),
        lastOutcome: transaction.outcome,
        lastError: ""
      });
      await removeCommittedEvents(vaultPath, transaction.eventIds);
      await writeTransaction(layout.transactions, updateTransaction(transaction, { state: "recovered", error: "" }));
      results.push({ transactionId: transaction.transactionId, action: "rolled-forward" });
      continue;
    }
    if (index.revision >= transaction.targetRevision && index.commitId !== transaction.transactionId) {
      await writeTransaction(layout.transactions, updateTransaction(transaction, {
        state: "recovered",
        outcome: "pending",
        error: `Superseded by formal commit ${index.commitId || "unknown"}`
      }));
      results.push({ transactionId: transaction.transactionId, action: "superseded" });
      continue;
    }
    await restoreBackups(layout, transaction.transactionId);
    await writeTransaction(layout.transactions, updateTransaction(transaction, { state: "recovered", outcome: "pending", error: "Recovered by rollback" }));
    results.push({ transactionId: transaction.transactionId, action: "rolled-back" });
  }
  return results;
}

export async function listMemoryTransactionIssues(vaultPath: string): Promise<MemoryTransactionIssue[]> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const issues: MemoryTransactionIssue[] = [];
  for (const entry of await readdir(layout.transactions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transaction = await readTransaction(layout.transactions, entry.name).catch(() => null);
    if (!transaction || transaction.state === "committed" || transaction.state === "recovered") continue;
    issues.push({
      transactionId: transaction.transactionId,
      state: transaction.state,
      eventIds: [...transaction.eventIds],
      error: transaction.error,
      updatedAt: transaction.updatedAt
    });
  }
  return issues.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function dismissMemoryTransaction(vaultPath: string, transactionId: string, reason: string): Promise<boolean> {
  return await withMemoryFormalMutation(vaultPath, async () => await dismissMemoryTransactionUnlocked(vaultPath, transactionId, reason));
}

async function dismissMemoryTransactionUnlocked(vaultPath: string, transactionId: string, reason: string): Promise<boolean> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const transaction = await readTransaction(layout.transactions, transactionId).catch(() => null);
  if (!transaction || transaction.state === "committed" || transaction.state === "recovered") return false;
  await removeCommittedEvents(vaultPath, transaction.eventIds);
  const dismissed = updateTransaction(transaction, {
    state: "committed",
    outcome: "no-op",
    error: `Dismissed by user: ${reason.trim() || "no reason"}`
  });
  await writeTransaction(layout.transactions, dismissed);
  await appendAudit(layout.audit, dismissed, "dismissed");
  return true;
}

export async function retryMemoryTransaction(
  vaultPath: string,
  transactionId: string,
  curator: MemoryCurator
): Promise<MemorySyncResult> {
  return await withMemoryFormalMutation(vaultPath, async () => await retryMemoryTransactionUnlocked(vaultPath, transactionId, curator));
}

async function retryMemoryTransactionUnlocked(
  vaultPath: string,
  transactionId: string,
  curator: MemoryCurator
): Promise<MemorySyncResult> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  let transaction = await readTransaction(layout.transactions, transactionId).catch(() => null);
  if (!transaction || transaction.state === "committed" || transaction.state === "recovered") {
    const manifest = await readMemoryManifestV2(vaultPath);
    return { outcome: "no-pending", revision: manifest.revision, committedMemoryIds: [], confirmationIds: [] };
  }
  if (transaction.state === "committing") {
    await recoverMemoryTransactionsUnlocked(vaultPath);
    const recovered = await readTransaction(layout.transactions, transactionId);
    transaction = recovered;
    if (recovered.outcome !== "pending" || !(await readPendingMemoryEvents(vaultPath)).some((event) => recovered.eventIds.includes(event.eventId))) {
      return syncResult(recovered);
    }
  }
  const retried = updateTransaction(transaction, {
    state: "recovered",
    outcome: "pending",
    error: `Superseded by explicit retry of ${transactionId}`
  });
  await writeTransaction(layout.transactions, retried);
  await appendAudit(layout.audit, retried, "retried");
  return await syncPendingMemoryUnlocked(vaultPath, curator, transaction.eventIds);
}

function buildStagedIndex(
  index: MemoryIndexV2<MemoryRecordV2>,
  result: MemoryCuratorResult,
  events: PendingMemoryEvent[],
  now: number
): { index: MemoryIndexV2<MemoryRecordV2>; committedMemoryIds: string[]; confirmationIds: string[] } {
  const next: MemoryIndexV2<MemoryRecordV2> = {
    schemaVersion: 2,
    revision: index.revision,
    ...(index.commitId ? { commitId: index.commitId } : {}),
    memories: index.memories.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs] })),
    confirmations: [...index.confirmations]
  };
  const confirmations = next.confirmations as MemoryConfirmationV2[];
  const committedMemoryIds: string[] = [];
  const confirmationIds: string[] = [];
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  for (const candidate of result.candidates) {
    if (candidate.disposition !== "write") continue;
    const statement = candidate.statement!.trim();
    const duplicate = next.memories.find((item) => isActive(item, now) && normalize(item.statement) === normalize(statement));
    if (duplicate) continue;
    const conflicts = next.memories
      .filter((item) => isActive(item, now) && item.kind === candidate.kind)
      .filter((item) => normalize(item.statement) !== normalize(statement))
      .filter((item) => conflictKey(item.statement) === conflictKey(statement)
        || memoryIdentityKey(item.id) === memoryIdentityKey(candidate.candidateId));
    const record = candidateRecord(candidate, eventById, now);
    if (candidate.requiresConfirmation || conflicts.length) {
      const id = `confirmation:${candidate.candidateId}`;
      if (!confirmations.some((item) => item.id === id)) {
        confirmations.push({
          id,
          candidate: withoutTimes(record),
          sourceEventIds: [...candidate.sourceEventIds],
          reason: candidate.reason,
          conflictsWith: conflicts.map((item) => item.id),
          createdAt: now
        });
        confirmationIds.push(id);
      }
      continue;
    }
    next.memories.push(record);
    committedMemoryIds.push(record.id);
  }
  return { index: next, committedMemoryIds, confirmationIds };
}

function candidateRecord(candidate: MemoryCuratorCandidate, events: Map<string, PendingMemoryEvent>, now: number): MemoryRecordV2 {
  const firstEvent = candidate.sourceEventIds.map((id) => events.get(id)).find(Boolean);
  return {
    id: candidate.candidateId,
    kind: candidate.kind!,
    scope: candidate.scope?.trim() || "vault",
    statement: candidate.statement!.trim(),
    evidenceRefs: [...candidate.evidenceRefs!],
    sourceRunId: candidate.sourceRunId?.trim() || firstEvent?.runId || "unknown",
    confidence: candidate.confidence!,
    createdAt: now,
    updatedAt: now
  };
}

function validateCandidate(candidate: MemoryCuratorCandidate): void {
  if (!candidate || typeof candidate !== "object") throw new Error("Invalid memory candidate");
  assertAllowedKeys(candidate as unknown as Record<string, unknown>, CURATOR_CANDIDATE_KEYS, "memory candidate");
  if (typeof candidate.candidateId !== "string" || !SAFE_MEMORY_ID.test(candidate.candidateId)) throw new Error("Memory candidate id is invalid");
  if (!(["write", "skip", "unresolved"] as string[]).includes(candidate.disposition)) throw new Error(`Invalid memory disposition for ${candidate.candidateId}`);
  if (!Array.isArray(candidate.sourceEventIds) || !candidate.sourceEventIds.length || candidate.sourceEventIds.length > MAX_PENDING_MEMORY_EVENTS || candidate.sourceEventIds.some((id) => typeof id !== "string" || !SAFE_MEMORY_REF.test(id))) {
    throw new Error(`Memory candidate ${candidate.candidateId} must cover source events`);
  }
  if (new Set(candidate.sourceEventIds).size !== candidate.sourceEventIds.length) throw new Error(`Memory candidate ${candidate.candidateId} repeats source events`);
  if (typeof candidate.reason !== "string" || !candidate.reason.trim() || candidate.reason.length > 1_000 || /[\r\n]/.test(candidate.reason) || DANGEROUS_CONTROL_CHARACTER.test(candidate.reason)) {
    throw new Error(`Memory candidate ${candidate.candidateId} requires a safe reason`);
  }
  if (candidate.scope !== undefined && candidate.scope !== "vault") throw new Error(`Memory candidate ${candidate.candidateId} has invalid scope`);
  if (candidate.sourceRunId !== undefined && (typeof candidate.sourceRunId !== "string" || !SAFE_MEMORY_REF.test(candidate.sourceRunId))) {
    throw new Error(`Memory candidate ${candidate.candidateId} has invalid sourceRunId`);
  }
  if (candidate.evidenceRefs !== undefined && (
    !Array.isArray(candidate.evidenceRefs)
    || candidate.evidenceRefs.length > 32
    || candidate.evidenceRefs.some((reference) => typeof reference !== "string" || !SAFE_MEMORY_REF.test(reference))
  )) throw new Error(`Memory candidate ${candidate.candidateId} has invalid evidenceRefs`);
  if (candidate.requiresConfirmation !== undefined && typeof candidate.requiresConfirmation !== "boolean") {
    throw new Error(`Memory candidate ${candidate.candidateId} has invalid requiresConfirmation`);
  }
  if (candidate.statement !== undefined && (typeof candidate.statement !== "string" || DANGEROUS_CONTROL_CHARACTER.test(candidate.statement))) {
    throw new Error(`Memory candidate ${candidate.candidateId} has invalid statement`);
  }
  if (candidate.disposition !== "write") return;
  if (!isMemoryKind(candidate.kind)) throw new Error(`Memory candidate ${candidate.candidateId} has invalid kind`);
  if (candidate.scope !== "vault") throw new Error(`Memory candidate ${candidate.candidateId} must use vault scope`);
  if (!candidate.statement?.trim() || candidate.statement.trim().length > 4_000) throw new Error(`Memory candidate ${candidate.candidateId} has invalid statement`);
  if (typeof candidate.sourceRunId !== "string" || !SAFE_MEMORY_REF.test(candidate.sourceRunId)) throw new Error(`Memory candidate ${candidate.candidateId} requires sourceRunId`);
  if (!Array.isArray(candidate.evidenceRefs) || !candidate.evidenceRefs.length) throw new Error(`Memory candidate ${candidate.candidateId} requires evidenceRefs`);
  if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    throw new Error(`Memory candidate ${candidate.candidateId} has invalid confidence`);
  }
}

function parseCuratorResult(raw: unknown): MemoryCuratorResult {
  let value = raw;
  if (typeof raw === "string") {
    value = JSON.parse(raw.trim()) as unknown;
  }
  if (!value || typeof value !== "object") throw new Error("Curator result must be an object");
  const result = value as MemoryCuratorResult;
  assertAllowedKeys(result as unknown as Record<string, unknown>, CURATOR_RESULT_KEYS, "curator result");
  if (result.schemaVersion !== 2) throw new Error("Curator result schemaVersion must be 2");
  if (!(["write", "no-op", "pending"] as string[]).includes(result.outcome)) throw new Error("Curator result outcome is invalid");
  if (typeof result.summary !== "string" || result.summary.length > 2_000 || DANGEROUS_CONTROL_CHARACTER.test(result.summary) || !Array.isArray(result.candidates) || result.candidates.length > MAX_PENDING_MEMORY_EVENTS) {
    throw new Error("Curator result summary and candidates are invalid");
  }
  return result;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unexpected field: ${key}`);
  }
}

async function installProjectionSet(layout: ReturnType<typeof echoInkMemoryV2Layout>, stagedRoot: string): Promise<void> {
  await atomicWriteText(layout.current, await readFile(path.join(stagedRoot, "current.md"), "utf8"));
  await atomicWriteText(path.join(layout.spec, "index.md"), await readFile(path.join(stagedRoot, "spec", "index.md"), "utf8"));
  await atomicWriteText(path.join(layout.tasks, "index.md"), await readFile(path.join(stagedRoot, "tasks", "index.md"), "utf8"));
  await atomicWriteText(path.join(layout.archive, "index.md"), await readFile(path.join(stagedRoot, "archive", "index.md"), "utf8"));
}

async function restoreBackups(layout: ReturnType<typeof echoInkMemoryV2Layout>, transactionId: string): Promise<void> {
  const backupDir = path.join(transactionDir(layout.transactions, transactionId), "backups");
  for (const file of formalFiles(layout)) {
    const backup = path.join(backupDir, backupName(layout.root, file));
    if (await pathExists(backup)) await atomicWriteText(file, await readFile(backup, "utf8"));
  }
}

async function removeCommittedEvents(vaultPath: string, eventIds: string[]): Promise<void> {
  const committed = new Set(eventIds);
  await replacePendingMemoryEvents(vaultPath, (events) => events.filter((event) => !committed.has(event.eventId)));
}

async function appendAudit(file: string, transaction: MemoryTransactionRecord, outcome: string): Promise<void> {
  const current = await readFile(file, "utf8").catch(() => "");
  await atomicWriteText(file, `${current}${JSON.stringify({
    transactionId: transaction.transactionId,
    revision: transaction.targetRevision,
    outcome,
    eventIds: transaction.eventIds,
    memoryIds: transaction.committedMemoryIds,
    confirmationIds: transaction.confirmationIds,
    at: Date.now()
  })}\n`);
}

async function writeManifestOutcome(vaultPath: string, outcome: "pending" | "failed", error: string): Promise<void> {
  const layout = await initializeEchoInkMemoryV2(vaultPath);
  const manifest = await readMemoryManifestV2(vaultPath);
  await atomicWriteJson(layout.manifest, {
    ...manifest,
    lastOutcome: outcome,
    lastError: error
  });
}

function transactionRecord(source: MemoryTransactionSource, now: number): MemoryTransactionRecord {
  return {
    schemaVersion: 2,
    transactionId: source.transactionId,
    state: "prepared",
    baseRevision: source.baseRevision,
    targetRevision: source.baseRevision,
    eventIds: source.events.map((event) => event.eventId),
    outcome: "pending",
    committedMemoryIds: [],
    confirmationIds: [],
    createdAt: now,
    updatedAt: now,
    error: ""
  };
}

function updateTransaction(transaction: MemoryTransactionRecord, patch: Partial<MemoryTransactionRecord>): MemoryTransactionRecord {
  return { ...transaction, ...patch, updatedAt: Date.now() };
}

async function readTransaction(root: string, transactionId: string): Promise<MemoryTransactionRecord> {
  return await readJson<MemoryTransactionRecord>(path.join(transactionDir(root, transactionId), "transaction.json"));
}

async function writeTransaction(root: string, transaction: MemoryTransactionRecord): Promise<void> {
  await atomicWriteJson(path.join(transactionDir(root, transaction.transactionId), "transaction.json"), transaction);
}

function transactionDir(root: string, transactionId: string): string {
  const safe = transactionId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(root, safe);
}

function syncResult(transaction: MemoryTransactionRecord): MemorySyncResult {
  return {
    transactionId: transaction.transactionId,
    outcome: transaction.outcome,
    revision: transaction.targetRevision,
    committedMemoryIds: [...transaction.committedMemoryIds],
    confirmationIds: [...transaction.confirmationIds],
    ...(transaction.error ? { error: transaction.error } : {})
  };
}

function formalFiles(layout: ReturnType<typeof echoInkMemoryV2Layout>): string[] {
  return [layout.index, layout.current, path.join(layout.spec, "index.md"), path.join(layout.tasks, "index.md"), path.join(layout.archive, "index.md"), layout.manifest];
}

function backupName(root: string, file: string): string {
  return path.relative(root, file).replace(/[\\/]/g, "__");
}

function withoutTimes(record: MemoryRecordV2): Omit<MemoryRecordV2, "createdAt" | "updatedAt"> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...candidate } = record;
  return candidate;
}

function isMemoryKind(value: unknown): value is MemoryRecordKind {
  return typeof value === "string" && ["current-state", "preference", "decision", "constraint", "open-loop", "task-state", "workflow-rule", "lesson"].includes(value);
}

function isActive(item: MemoryRecordV2, now: number): boolean {
  return !item.supersededAt && !item.deletedAt && !item.expiredAt && !(typeof item.expiresAt === "number" && item.expiresAt <= now);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[。.!]+$/, "").trim();
}

function conflictKey(value: string): string {
  const normalized = normalize(value).replace(/^(?:用户)?(?:偏好|决定|约束|规则)\s*/, "");
  return (normalized.split(/[:：=]|\s+(?:is|are|was|equals?)\s+|(?:是|为)(?=\s+|["'“‘「『【[(]|\d|[a-z])/i)[0] || normalized)
    .slice(0, 80)
    .trim();
}

function memoryIdentityKey(value: string): string {
  return value.toLowerCase().replace(/(?:[-_.:](?:update|updated|replacement|new|latest|revision[-_.:]?\d+))+$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function pathExists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}
