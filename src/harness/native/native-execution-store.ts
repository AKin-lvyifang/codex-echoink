import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  hasValidNativeExecutionIdentityContract,
  isSafeNativeExecutionTransport,
  isNativeCleanupAuthorityEvidenceMissing,
  isValidEchoInkHostProcessDispositionReceipt,
  nativeRetirementSourceIdentityState,
  nativeRetirementTargetState,
  type NativeExecutionRecord
} from "../contracts/native-execution";

export const NATIVE_EXECUTION_STORE_SCHEMA_VERSION = 2;

interface NativeExecutionIndex {
  version: 1 | typeof NATIVE_EXECUTION_STORE_SCHEMA_VERSION;
  updatedAt: number;
  records: NativeExecutionRecord[];
}

type NativeExecutionStoreEvent =
  | { type: "upsert"; record: NativeExecutionRecord; createdAt: number }
  | { type: "remove"; id: string; createdAt: number };

export interface NativeExecutionStoreOptions {
  rootPath: string;
  now?: () => number;
  onAuditWarning?: (warning: string) => void;
}

const mutationTailsByRoot = new Map<string, Promise<void>>();

export class NativeExecutionStoreMigrationRequiredError extends Error {
  readonly code = "NATIVE_EXECUTION_STORE_MIGRATION_REQUIRED";

  constructor(readonly currentVersion: number) {
    super(
      `Native Execution Store schema v${currentVersion} is read-only; `
      + `explicit migration to v${NATIVE_EXECUTION_STORE_SCHEMA_VERSION} is required before mutation`
    );
    this.name = "NativeExecutionStoreMigrationRequiredError";
  }
}

export class NativeExecutionStoreRecoveryRequiredError extends Error {
  readonly code = "NATIVE_EXECUTION_STORE_RECOVERY_REQUIRED";

  constructor(readonly detail = "authority index is missing/blank or an audit projection already exists") {
    super(
      `Native Execution Store requires explicit recovery: ${detail}`
    );
    this.name = "NativeExecutionStoreRecoveryRequiredError";
  }
}

export class NativeExecutionStoreRebuildUnsupportedError extends Error {
  readonly code = "NATIVE_EXECUTION_STORE_REBUILD_UNSUPPORTED";

  constructor() {
    super("Native Execution Store audit events are not authoritative and cannot rebuild the index");
    this.name = "NativeExecutionStoreRebuildUnsupportedError";
  }
}

export class NativeExecutionStore {
  private readonly now: () => number;
  private readonly rootCoordinationKey: string;
  private readonly auditWarnings: string[] = [];

  constructor(private readonly options: NativeExecutionStoreOptions) {
    this.now = options.now ?? Date.now;
    this.rootCoordinationKey = path.resolve(options.rootPath);
  }

  async upsert(record: NativeExecutionRecord): Promise<void> {
    await this.enqueueMutation(async () => await this.upsertUnlocked(record));
  }

  async insertIfAbsent(record: NativeExecutionRecord): Promise<NativeExecutionRecord> {
    return await this.enqueueMutation(async () => {
      const index = await this.readIndexUnlocked();
      assertMutableIndex(index);
      const existing = index.records.find((item) => item.id === record.id);
      if (existing) return existing;
      assertValidRecordForMutation(record);
      index.records.push(record);
      index.updatedAt = this.now();
      await this.commitIndexWithAudit(index, [{
        type: "upsert",
        record,
        createdAt: this.now()
      }]);
      return record;
    });
  }

  async update(id: string, updater: (record: NativeExecutionRecord) => NativeExecutionRecord): Promise<NativeExecutionRecord | null> {
    return await this.enqueueMutation(async () => {
      const index = await this.readIndexUnlocked();
      assertMutableIndex(index);
      const existingIndex = index.records.findIndex((record) => record.id === id);
      if (existingIndex < 0) return null;
      const next = updater({ ...index.records[existingIndex] });
      assertValidRecordForMutation(next);
      if (isDeepStrictEqual(next, index.records[existingIndex])) {
        return index.records[existingIndex];
      }
      index.records[existingIndex] = next;
      index.updatedAt = this.now();
      await this.commitIndexWithAudit(index, [{
        type: "upsert",
        record: next,
        createdAt: this.now()
      }]);
      return next;
    });
  }

  async get(id: string): Promise<NativeExecutionRecord | null> {
    await this.currentMutationTail();
    const index = await this.readIndexUnlocked();
    return index.records.find((record) => record.id === id) ?? null;
  }

  async list(): Promise<NativeExecutionRecord[]> {
    await this.currentMutationTail();
    const index = await this.readIndexUnlocked();
    return [...index.records].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  listAuditWarnings(): string[] {
    return [...this.auditWarnings];
  }

  coordinationKey(): string {
    return this.rootCoordinationKey;
  }

  async listDueCleanup(now = this.now(), limit = 20): Promise<NativeExecutionRecord[]> {
    const records = await this.list();
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (!boundedLimit) return [];
    const due = records
      .filter((record) => isExecutableCleanup(record, now))
      .sort(compareCleanupPriority);
    const firstAttempts = due.filter((record) => record.attempts === 0);
    const retries = due.filter((record) => record.attempts > 0);
    const firstAttemptQuota = Math.min(firstAttempts.length, Math.max(1, Math.ceil(boundedLimit / 2)));
    const retryQuota = Math.min(retries.length, Math.floor(boundedLimit / 2));
    const selected = [
      ...firstAttempts.slice(0, firstAttemptQuota),
      ...retries.slice(0, retryQuota)
    ];
    if (selected.length < boundedLimit) {
      const selectedIds = new Set(selected.map((record) => record.id));
      selected.push(...due.filter((record) => !selectedIds.has(record.id)).slice(0, boundedLimit - selected.length));
    }
    return selected;
  }

  async claimCleanup(
    id: string,
    now = this.now(),
    options: { ignoreSchedule?: boolean } = {}
  ): Promise<NativeExecutionRecord | null> {
    return await this.enqueueMutation(async () => {
      const index = await this.readIndexUnlocked();
      assertMutableIndex(index);
      const existingIndex = index.records.findIndex((record) => record.id === id);
      if (existingIndex < 0) return null;
      const current = index.records[existingIndex];
      if (!isExecutableCleanup(current, options.ignoreSchedule ? Number.MAX_SAFE_INTEGER : now)) return null;
      const claimed: NativeExecutionRecord = {
        ...current,
        cleanup: "disposing",
        cleanupStartedAt: now,
        attempts: current.attempts + 1
      };
      index.records[existingIndex] = claimed;
      index.updatedAt = this.now();
      await this.commitIndexWithAudit(index, [{
        type: "upsert",
        record: claimed,
        createdAt: this.now()
      }]);
      return claimed;
    });
  }

  async requeueInterruptedCleanupClaims(
    reason: string,
    now = this.now(),
    excludedRecordIds: ReadonlySet<string> = new Set()
  ): Promise<number> {
    return await this.enqueueMutation(async () => {
      const index = await this.readIndexUnlocked();
      assertMutableIndex(index);
      let changed = 0;
      const auditEvents: NativeExecutionStoreEvent[] = [];
      for (let recordIndex = 0; recordIndex < index.records.length; recordIndex += 1) {
        const current = index.records[recordIndex];
        if (
          current.cleanup !== "disposing"
          || excludedRecordIds.has(current.id)
        ) {
          continue;
        }
        const { cleanupStartedAt: _cleanupStartedAt, ...rest } = current;
        const exhausted = current.attempts >= 6;
        const next: NativeExecutionRecord = {
          ...rest,
          cleanup: exhausted ? "quarantined" : "failed",
          nextAttemptAt: exhausted ? 0 : now,
          ...(exhausted
            ? { quarantinedAt: current.quarantinedAt || now }
            : {}),
          lastError: mergeErrorMessage(current.lastError, reason)
        };
        index.records[recordIndex] = next;
        auditEvents.push({ type: "upsert", record: next, createdAt: this.now() });
        changed += 1;
      }
      if (changed) {
        index.updatedAt = this.now();
        await this.commitIndexWithAudit(index, auditEvents);
      }
      return changed;
    });
  }

  async quarantineExhaustedCleanupAttempts(
    reason: string,
    now = this.now()
  ): Promise<number> {
    return await this.enqueueMutation(async () => {
      const index = await this.readIndexUnlocked();
      assertMutableIndex(index);
      let changed = 0;
      const auditEvents: NativeExecutionStoreEvent[] = [];
      for (let recordIndex = 0; recordIndex < index.records.length; recordIndex += 1) {
        const current = index.records[recordIndex];
        if (
          (current.cleanup !== "pending" && current.cleanup !== "failed")
          || current.attempts < 6
        ) {
          continue;
        }
        const { cleanupStartedAt: _cleanupStartedAt, ...rest } = current;
        const next: NativeExecutionRecord = {
          ...rest,
          cleanup: "quarantined",
          nextAttemptAt: 0,
          quarantinedAt: current.quarantinedAt || now,
          lastError: mergeErrorMessage(current.lastError, reason)
        };
        index.records[recordIndex] = next;
        auditEvents.push({ type: "upsert", record: next, createdAt: this.now() });
        changed += 1;
      }
      if (changed) {
        index.updatedAt = this.now();
        await this.commitIndexWithAudit(index, auditEvents);
      }
      return changed;
    });
  }

  async rebuildIndexFromEvents(): Promise<NativeExecutionRecord[]> {
    return await this.enqueueMutation(async () => {
      throw new NativeExecutionStoreRebuildUnsupportedError();
    });
  }

  private async upsertUnlocked(record: NativeExecutionRecord): Promise<void> {
    const index = await this.readIndexUnlocked();
    assertMutableIndex(index);
    assertValidRecordForMutation(record);
    const existingIndex = index.records.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) index.records[existingIndex] = record;
    else index.records.push(record);
    index.updatedAt = this.now();
    await this.commitIndexWithAudit(index, [{
      type: "upsert",
      record,
      createdAt: this.now()
    }]);
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.currentMutationTail();
    const run = previous.then(operation, operation);
    const tail = run.then(() => undefined, () => undefined);
    mutationTailsByRoot.set(this.rootCoordinationKey, tail);
    try {
      return await run;
    } finally {
      if (mutationTailsByRoot.get(this.rootCoordinationKey) === tail) {
        mutationTailsByRoot.delete(this.rootCoordinationKey);
      }
    }
  }

  private currentMutationTail(): Promise<void> {
    return mutationTailsByRoot.get(this.rootCoordinationKey) ?? Promise.resolve();
  }

  private async readIndexUnlocked(): Promise<NativeExecutionIndex> {
    const rootDirectory = await readDirectoryState(this.options.rootPath);
    const tempResidues = rootDirectory.entries.filter(isNativeExecutionIndexTempResidue);
    if (tempResidues.length > 0) {
      throw new NativeExecutionStoreRecoveryRequiredError(
        `partial authority index residue exists (${tempResidues.sort().join(", ")})`
      );
    }
    const indexFile = await readTextFileState(this.indexPath());
    if (!indexFile.exists) {
      const eventsFile = await readTextFileState(this.eventsPath());
      if (eventsFile.exists) throw new NativeExecutionStoreRecoveryRequiredError();
      if (rootDirectory.exists && rootDirectory.entries.length > 0) {
        throw new NativeExecutionStoreRecoveryRequiredError();
      }
      return {
        version: NATIVE_EXECUTION_STORE_SCHEMA_VERSION,
        updatedAt: 0,
        records: []
      };
    }
    if (!indexFile.text.trim()) {
      throw new NativeExecutionStoreRecoveryRequiredError();
    }
    const parsed = JSON.parse(indexFile.text) as Partial<NativeExecutionIndex>;
    if (parsed.version !== 1 && parsed.version !== NATIVE_EXECUTION_STORE_SCHEMA_VERSION) {
      throw new Error(`Unsupported Native Execution Store schema version: ${String(parsed.version)}`);
    }
    if (!isSafeNonNegativeInteger(parsed.updatedAt)) {
      throw new Error("Invalid Native Execution Store index: updatedAt must be a finite non-negative safe integer");
    }
    if (!Array.isArray(parsed.records)) {
      throw new Error("Invalid Native Execution Store index: records must be an array");
    }
    const invalidRecordIndex = parsed.records.findIndex((record) => !isNativeExecutionRecord(record));
    if (invalidRecordIndex >= 0) {
      throw new Error(`Invalid Native Execution Store record at index ${invalidRecordIndex}`);
    }
    const seenIds = new Set<string>();
    for (let recordIndex = 0; recordIndex < parsed.records.length; recordIndex += 1) {
      const id = parsed.records[recordIndex].id;
      if (seenIds.has(id)) {
        throw new Error(`Duplicate Native Execution Store record id at index ${recordIndex}`);
      }
      seenIds.add(id);
    }
    return {
      version: parsed.version,
      updatedAt: parsed.updatedAt,
      records: parsed.records
    };
  }

  private async writeIndex(index: NativeExecutionIndex): Promise<void> {
    assertMutableIndex(index);
    const target = this.indexPath();
    const current: NativeExecutionIndex = {
      ...index,
      version: NATIVE_EXECUTION_STORE_SCHEMA_VERSION
    };
    await mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(path.dirname(target), `.native-executions-index.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async commitIndexWithAudit(
    index: NativeExecutionIndex,
    events: readonly NativeExecutionStoreEvent[]
  ): Promise<void> {
    await this.writeIndex(index);
    for (const event of events) {
      await this.appendAuditEvent(event);
    }
  }

  private async appendAuditEvent(event: NativeExecutionStoreEvent): Promise<void> {
    try {
      await this.appendEvent(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const warning = `Native Execution Store audit append failed for ${event.type}: ${message}`;
      this.auditWarnings.push(warning);
      try {
        this.options.onAuditWarning?.(warning);
      } catch {
        // An observer cannot reverse the already-committed authority mutation.
      }
    }
  }

  private async appendEvent(event: NativeExecutionStoreEvent): Promise<void> {
    const target = this.eventsPath();
    await mkdir(path.dirname(target), { recursive: true });
    const handle = await open(target, "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private indexPath(): string {
    return path.join(this.options.rootPath, "native-executions-index.json");
  }

  private eventsPath(): string {
    return path.join(this.options.rootPath, "native-executions.jsonl");
  }
}

function assertMutableIndex(index: NativeExecutionIndex): asserts index is NativeExecutionIndex & {
  version: typeof NATIVE_EXECUTION_STORE_SCHEMA_VERSION;
} {
  if (index.version !== NATIVE_EXECUTION_STORE_SCHEMA_VERSION) {
    throw new NativeExecutionStoreMigrationRequiredError(index.version);
  }
}

function assertValidRecordForMutation(record: NativeExecutionRecord): void {
  if (!isNativeExecutionRecord(record)) {
    throw new Error("Invalid Native Execution Store record mutation");
  }
}

function isNativeExecutionRecord(value: unknown): value is NativeExecutionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<NativeExecutionRecord>;
  const native = record.native;
  const policy = record.policy;
  return (
    isNonEmptyString(record.id)
    && isNonEmptyString(record.runId)
    && isNonEmptyString(record.sessionId)
    && isOneOf(record.surface, ["knowledge", "editor", "review", "chat", "system"])
    && isNonEmptyString(record.workflow)
    && Boolean(
      native
      && isNonEmptyString(native.backendId)
      && isNonEmptyString(native.id)
      && isOneOf(native.kind, ["thread", "session", "run", "process"])
      && isOneOf(native.persistence, ["none", "process-local", "provider-persistent", "unknown"])
      && (
        native.transport === undefined
        || isSafeNativeExecutionTransport(native.transport)
      )
      && hasValidNativeExecutionIdentityContract(native)
      && (native.providerEndpoint === undefined || typeof native.providerEndpoint === "string")
      && isNonEmptyString(native.deviceKey)
      && isNonEmptyString(native.vaultId)
      && isSafeNonNegativeInteger(native.createdAt)
    )
    && Boolean(
      policy
      && isOneOf(policy.historyAuthority, ["echoink", "backend", "hybrid"])
      && isOneOf(policy.mode, ["ephemeral-run", "leased-conversation", "persistent-native"])
      && Array.isArray(policy.preferredDisposition)
      && policy.preferredDisposition.every(isNativeDisposition)
      && typeof policy.retainWhenLocalCommitFails === "boolean"
      && policy.cleanupRequiredForTaskSuccess === false
    )
    && isValidLocalCommitAuthority(record.localCommitAuthority)
    && isValidObservedDisposition(record as NativeExecutionRecord)
    && (record.runOutcome === undefined || isOneOf(record.runOutcome, ["success", "failed", "cancelled"]))
    && isOneOf(record.localCommit, ["pending", "committed", "failed"])
    && isNativeCleanupStatus(record.cleanup)
    && (record.requestedDisposition === undefined || isNativeDisposition(record.requestedDisposition))
    && (record.appliedDisposition === undefined || isNativeDisposition(record.appliedDisposition))
    && isSafeNonNegativeInteger(record.attempts)
    && isSafeNonNegativeInteger(record.nextAttemptAt)
    && typeof record.lastError === "string"
    && isSafeNonNegativeInteger(record.createdAt)
    && isSafeNonNegativeInteger(record.settledAt)
    && isSafeNonNegativeInteger(record.committedAt)
    && isSafeNonNegativeInteger(record.disposedAt)
    && (record.cleanupStartedAt === undefined || isSafeNonNegativeInteger(record.cleanupStartedAt))
    && (record.quarantinedAt === undefined || isSafeNonNegativeInteger(record.quarantinedAt))
    && isValidRetirement(record.retirement)
    && isValidCleanupLifecycle(record as NativeExecutionRecord)
    && (record.emitEvents === undefined || typeof record.emitEvents === "boolean")
    && (
      record.dispositionReason === undefined
      || isOneOf(record.dispositionReason, [
        "knowledge-run-completed",
        "knowledge-run-failed",
        "knowledge-run-cancelled",
        "recovery",
        "manual"
      ])
    )
  );
}

function isValidLocalCommitAuthority(
  value: NativeExecutionRecord["localCommitAuthority"] | undefined
): boolean {
  if (value === undefined) return true;
  return value.kind === "memory-transaction"
    && isNonEmptyString(value.transactionId);
}

function isValidObservedDisposition(record: NativeExecutionRecord): boolean {
  if (record.observedDisposition === undefined) return true;
  return isValidEchoInkHostProcessDispositionReceipt(
    record.native,
    record.observedDisposition
  );
}

function isValidCleanupLifecycle(record: NativeExecutionRecord): boolean {
  if (record.cleanup === "awaiting-local-commit") {
    return record.localCommit === "pending"
      && Boolean(record.retirement)
      && record.cleanupStartedAt === undefined
      && record.quarantinedAt === undefined;
  }
  if (record.cleanup === "not-needed") {
    return (record.localCommit === "pending" || record.localCommit === "committed")
      && record.retirement === undefined
      && record.cleanupStartedAt === undefined
      && record.quarantinedAt === undefined;
  }
  if (record.cleanup === "pending") {
    return record.localCommit === "committed"
      && record.cleanupStartedAt === undefined
      && record.quarantinedAt === undefined;
  }
  if (record.cleanup === "disposing") {
    return record.localCommit === "committed"
      && record.attempts > 0
      && record.cleanupStartedAt !== undefined
      && record.quarantinedAt === undefined;
  }
  if (
    record.cleanup === "disposed"
    || record.cleanup === "unsupported"
    || record.cleanup === "failed"
    || record.cleanup === "retained"
  ) {
    const validTerminal = record.localCommit === "committed"
      && record.cleanupStartedAt === undefined
      && record.quarantinedAt === undefined;
    if (!validTerminal) return false;
    if (
      record.native.identityAuthority === "echoink-host"
      && record.cleanup === "disposed"
    ) {
      return Boolean(
        record.observedDisposition
        && record.requestedDisposition === "process-exit"
        && record.appliedDisposition === "process-exit"
        && record.disposedAt === record.observedDisposition.observedAt
      );
    }
    return true;
  }
  if (record.cleanup === "retained-for-recovery") {
    return record.localCommit === "failed"
      && record.cleanupStartedAt === undefined
      && record.quarantinedAt === undefined;
  }
  if (record.cleanup === "aborted") {
    return record.localCommit === "failed"
      && Boolean(record.retirement)
      && record.cleanupStartedAt === undefined
      && record.quarantinedAt === undefined;
  }
  return record.cleanup === "quarantined"
    && (
      record.localCommit === "committed"
      || (
        record.localCommit === "pending"
        && (
          Boolean(record.retirement)
          || record.native.identityAuthority === "echoink-host"
        )
      )
    )
    && record.cleanupStartedAt === undefined
    && record.quarantinedAt !== undefined;
}

function isExecutableCleanup(record: NativeExecutionRecord, now: number): boolean {
  return (
    (record.cleanup === "pending" || record.cleanup === "failed") &&
    record.localCommit === "committed" &&
    !isNativeCleanupAuthorityEvidenceMissing(record) &&
    record.attempts < 6 &&
    record.nextAttemptAt <= now
  );
}

function isNativeExecutionIndexTempResidue(entry: string): boolean {
  return entry.startsWith(".native-executions-index.")
    && entry.endsWith(".tmp");
}

function compareCleanupPriority(left: NativeExecutionRecord, right: NativeExecutionRecord): number {
  return left.nextAttemptAt - right.nextAttemptAt
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}

function isNativeCleanupStatus(value: unknown): value is NativeExecutionRecord["cleanup"] {
  return value === "not-needed"
    || value === "awaiting-local-commit"
    || value === "pending"
    || value === "disposing"
    || value === "disposed"
    || value === "unsupported"
    || value === "failed"
    || value === "retained-for-recovery"
    || value === "retained"
    || value === "aborted"
    || value === "quarantined";
}

function isNativeDisposition(value: unknown): value is NativeExecutionRecord["requestedDisposition"] {
  return isOneOf(value, ["process-exit", "archive", "delete", "retain"]);
}

function isValidRetirement(value: NativeExecutionRecord["retirement"] | undefined): boolean {
  if (value === undefined) return true;
  return Boolean(
    value
    && (
      value.recordMutationId === undefined
      || isNonEmptyString(value.recordMutationId)
    )
    && typeof value.targetConversationId === "string"
    && value.targetConversationId.trim()
    && nativeRetirementSourceIdentityState(value) !== "invalid"
    && nativeRetirementTargetState(value) !== "invalid"
    && (
      nativeRetirementTargetState(value) !== "deleted"
      || (
        isNonEmptyString(value.recordMutationId)
        && nativeRetirementSourceIdentityState(value) === "complete"
        && value.reason === "delete-conversation"
      )
    )
    && typeof value.reason === "string"
    && value.reason.trim()
  );
}

function mergeErrorMessage(current: string, next: string): string {
  if (!current) return next;
  if (!next || current.includes(next)) return current;
  return `${current}; ${next}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

async function readTextFileState(target: string): Promise<{ exists: boolean; text: string }> {
  try {
    return { exists: true, text: await readFile(target, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, text: "" };
    }
    throw error;
  }
}

async function readDirectoryState(
  target: string
): Promise<{ exists: boolean; entries: string[] }> {
  try {
    return { exists: true, entries: await readdir(target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, entries: [] };
    }
    throw error;
  }
}
