import { normalizePiWorkspacePermission } from "./pi-workspace-access";
import { isDeepStrictEqual } from "node:util";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type {
  PiConversationCatalogEntry,
  PiConversationMemoryMode,
  PiKnowledgeObservation,
  PiMemoryRecallObservation,
  PiProductRunRecord,
  PiProductRunState,
  PiProductRunTerminalState
} from "./contracts";
import {
  PI_NATIVE_FILE_SCHEMA_VERSION,
  PiNativeFileStoreError,
  atomicWriteJsonFile,
  ensurePiNativeVaultFileLayout,
  isNodeErrorWithCode,
  piNativeVaultFileLayout,
  readJsonFileIfPresent,
  requireExactKeys,
  requireNonEmptyString,
  requirePlainObject,
  requireTimestamp,
  serializePiNativeFileWrite,
  stablePathToken,
  type PiNativeVaultFileLayout
} from "./file-store-utils";

const PRODUCT_RUN_STATES = new Set<PiProductRunState>([
  "accepted",
  "running",
  "agent_settled",
  "finalizing",
  "product_run_settled"
]);
const PRODUCT_RUN_TERMINAL_STATES = new Set<PiProductRunTerminalState>([
  "completed",
  "failed",
  "cancelled"
]);
const MEMORY_MODES = new Set<PiConversationMemoryMode>([
  "normal",
  "no_memory"
]);
const STATE_RANK: Record<PiProductRunState, number> = {
  accepted: 0,
  running: 1,
  agent_settled: 2,
  finalizing: 3,
  product_run_settled: 4
};

interface ProductRunDocumentV1 {
  schemaVersion: typeof PI_NATIVE_FILE_SCHEMA_VERSION;
  vaultId: string;
  run: PiProductRunRecord;
}

/**
 * The ProductRun files remain authoritative. This index contains only the
 * identifiers needed to narrow a lookup or a per-conversation list without
 * parsing every durable run document again.
 */
interface ProductRunMetadataIndexEntry {
  productRunId: string;
  conversationId: string;
  createdAt: number;
}

interface CachedProductRun {
  run: PiProductRunRecord;
  fileStamp: string;
}

interface LoadedProductRunFile {
  run: PiProductRunRecord;
  fileStamp: string;
}

export interface PiConversationCatalogBindingReader {
  get(
    conversationId: string
  ): Promise<Readonly<PiConversationCatalogEntry> | null>;
}

export interface FileProductRunStoreOptions {
  /** Must be the same common root used by FileConversationCatalog. */
  storageRootPath: string;
  vaultId: string;
  catalog: PiConversationCatalogBindingReader;
  now?: () => number;
}

export type PiProductRunUpdate = Partial<Pick<
  PiProductRunRecord,
  | "assistantEntryId"
  | "toolCallIds"
  | "state"
  | "terminalState"
  | "activeLeafId"
  | "agentSettledAt"
  | "settledAt"
  | "error"
  | "memoryRecall"
  | "knowledge"
  | "maintenance"
>> & {
  updatedAt?: number;
};

/** File-per-run store containing only Pi Entry / Tool pointers and terminal state. */
export class FileProductRunStore {
  readonly vaultId: string;
  readonly storageRootPath: string;
  readonly vaultRootPath: string;
  readonly rootPath: string;

  private readonly layout: PiNativeVaultFileLayout;
  private readonly catalog: PiConversationCatalogBindingReader;
  private readonly now: () => number;
  private readonly metadataById = new Map<
    string,
    ProductRunMetadataIndexEntry
  >();
  private readonly runIdsByConversation = new Map<string, Set<string>>();
  private readonly runCache = new Map<string, CachedProductRun>();
  private initialization: Promise<void> | null = null;

  constructor(options: FileProductRunStoreOptions) {
    this.vaultId = requireNonEmptyString(options.vaultId, "vaultId");
    this.layout = piNativeVaultFileLayout(
      options.storageRootPath,
      this.vaultId
    );
    this.storageRootPath = this.layout.storageRootPath;
    this.vaultRootPath = this.layout.vaultRootPath;
    this.rootPath = this.layout.productRunsRootPath;
    this.catalog = options.catalog;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      const initialization = serializePiNativeFileWrite(
        this.storageRootPath,
        async () => {
          await ensurePiNativeVaultFileLayout(this.layout);
          await this.rebuildMetadataIndex();
        }
      );
      this.initialization = initialization;
      try {
        await initialization;
      } catch (error) {
        if (this.initialization === initialization) {
          this.initialization = null;
        }
        throw error;
      }
      return;
    }
    await this.initialization;
  }

  async create(
    input: Readonly<PiProductRunRecord>
  ): Promise<Readonly<PiProductRunRecord>> {
    await this.ensureMetadataIndex();
    const candidate = normalizeProductRun(input);
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        await ensurePiNativeVaultFileLayout(this.layout);
        const binding = await this.requireCatalogBinding(candidate);
        if (binding.status === "deleted") {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `已删除的 Conversation ${candidate.conversationId} 不能创建 ProductRun`
          );
        }
        const existing = await this.read(candidate.productRunId);
        if (existing) {
          if (!isDeepStrictEqual(existing, candidate)) {
            throw new PiNativeFileStoreError(
              "mapping-conflict",
              `productRunId ${candidate.productRunId} 已由另一条 ProductRun 占用`
            );
          }
          return cloneProductRun(existing);
        }
        const readback = await this.writeRun(candidate);
        return cloneProductRun(readback);
      }
    );
  }

  async update(
    productRunId: string,
    update: Readonly<PiProductRunUpdate>
  ): Promise<Readonly<PiProductRunRecord>> {
    await this.ensureMetadataIndex();
    const normalizedRunId = requireNonEmptyString(
      productRunId,
      "productRunId"
    );
    assertUpdateKeys(update);
    return await serializePiNativeFileWrite(
      this.storageRootPath,
      async () => {
        const existing = await this.read(normalizedRunId);
        if (!existing) {
          throw new PiNativeFileStoreError(
            "not-found",
            `ProductRun ${normalizedRunId} 不存在`
          );
        }
        await this.requireCatalogBinding(existing);
        if (
          existing.state === "product_run_settled"
          && hasTerminalMutation(existing, update)
        ) {
          throw new PiNativeFileStoreError(
            "invalid-transition",
            `已结算的 ProductRun ${normalizedRunId} 不可改写`
          );
        }
        const updatedAt = requireTimestamp(
          update.updatedAt ?? this.now(),
          "productRun.updatedAt"
        );
        if (updatedAt < existing.updatedAt) {
          throw new PiNativeFileStoreError(
            "invalid-input",
            `ProductRun ${normalizedRunId} 的 updatedAt 不得回退`
          );
        }
        const candidate = normalizeProductRun({
          ...cloneProductRun(existing),
          ...definedUpdate(update),
          updatedAt,
          toolCallIds: update.toolCallIds
            ? [...update.toolCallIds]
            : [...existing.toolCallIds]
        });
        assertStateProgression(existing, candidate);
        const readback = await this.writeRun(candidate);
        return cloneProductRun(readback);
      }
    );
  }

  async read(
    productRunId: string
  ): Promise<Readonly<PiProductRunRecord> | null> {
    await this.ensureMetadataIndex();
    const normalizedRunId = requireNonEmptyString(
      productRunId,
      "productRunId"
    );
    const indexed = this.metadataById.get(normalizedRunId);
    if (indexed) return await this.readIndexedRun(indexed);

    // A file created outside this process may not be present in the warm
    // index yet. Probe only its deterministic path; never rescan every file
    // for a point lookup.
    const loaded = await this.loadProductRunFile(
      this.runFilePath(normalizedRunId),
      `ProductRun ${normalizedRunId}`
    );
    if (!loaded) return null;
    if (loaded.run.productRunId !== normalizedRunId) {
      throw new PiNativeFileStoreError(
        "store-corrupt",
        `ProductRun ${normalizedRunId} 的文件名与记录身份不匹配`
      );
    }
    this.rememberRun(loaded);
    return cloneProductRun(loaded.run);
  }

  async list(
    conversationId?: string
  ): Promise<Readonly<PiProductRunRecord>[]> {
    await this.ensureMetadataIndex();
    const normalizedConversationId = conversationId === undefined
      ? undefined
      : requireNonEmptyString(conversationId, "conversationId");
    await this.synchronizeMetadataIndex();
    const indexed = normalizedConversationId === undefined
      ? [...this.metadataById.values()]
      : [...(this.runIdsByConversation.get(normalizedConversationId) ?? [])]
        .map((productRunId) => this.metadataById.get(productRunId))
        .filter((entry): entry is ProductRunMetadataIndexEntry => Boolean(entry));
    const runs: PiProductRunRecord[] = [];
    for (const entry of indexed.sort(compareProductRunIndexEntries)) {
      const run = await this.readIndexedRun(entry);
      if (!run) continue;
      if (
        normalizedConversationId === undefined
        || run.conversationId === normalizedConversationId
      ) {
        runs.push(run);
      }
    }
    return runs.sort((left, right) =>
      left.createdAt - right.createdAt
      || left.productRunId.localeCompare(right.productRunId)
    );
  }

  private runFilePath(productRunId: string): string {
    return path.join(
      this.rootPath,
      `${stablePathToken(productRunId)}.json`
    );
  }

  private async ensureMetadataIndex(): Promise<void> {
    await this.initialize();
  }

  private async rebuildMetadataIndex(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.rootPath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        this.metadataById.clear();
        this.runIdsByConversation.clear();
        this.runCache.clear();
        return;
      }
      throw error;
    }
    const loadedRuns: LoadedProductRunFile[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const loaded = await this.loadProductRunFile(
        path.join(this.rootPath, name),
        `ProductRun file ${name}`
      );
      if (!loaded) continue;
      this.assertFileNameMatchesRun(name, loaded.run);
      loadedRuns.push(loaded);
    }
    this.metadataById.clear();
    this.runIdsByConversation.clear();
    this.runCache.clear();
    for (const loaded of loadedRuns) {
      this.indexRun(loaded.run);
    }
  }

  /**
   * Discover only added or removed files between warm calls. Existing files
   * keep their metadata entry; `readIndexedRun` checks their stamp before a
   * cached body is reused.
   */
  private async synchronizeMetadataIndex(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.rootPath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        this.metadataById.clear();
        this.runIdsByConversation.clear();
        this.runCache.clear();
        return;
      }
      throw error;
    }
    const jsonNames = names.filter((name) => name.endsWith(".json"));
    const existingNames = new Set(jsonNames);
    for (const productRunId of [...this.metadataById.keys()]) {
      if (!existingNames.has(this.runFileName(productRunId))) {
        this.removeIndexedRun(productRunId);
      }
    }
    const knownNames = new Set(
      [...this.metadataById.keys()].map((productRunId) =>
        this.runFileName(productRunId)
      )
    );
    for (const name of jsonNames.sort()) {
      if (knownNames.has(name)) continue;
      const loaded = await this.loadProductRunFile(
        path.join(this.rootPath, name),
        `ProductRun file ${name}`
      );
      if (!loaded) continue;
      this.assertFileNameMatchesRun(name, loaded.run);
      this.rememberRun(loaded);
    }
  }

  private async readIndexedRun(
    entry: ProductRunMetadataIndexEntry
  ): Promise<PiProductRunRecord | null> {
    const loaded = await this.loadProductRunFile(
      this.runFilePath(entry.productRunId),
      `ProductRun ${entry.productRunId}`,
      this.runCache.get(entry.productRunId)
    );
    if (!loaded) {
      this.removeIndexedRun(entry.productRunId);
      return null;
    }
    if (loaded.run.productRunId !== entry.productRunId) {
      throw new PiNativeFileStoreError(
        "store-corrupt",
        `ProductRun ${entry.productRunId} 的文件名与记录身份不匹配`
      );
    }
    this.rememberRun(loaded);
    return cloneProductRun(loaded.run);
  }

  private async loadProductRunFile(
    filePath: string,
    label: string,
    cached?: CachedProductRun
  ): Promise<LoadedProductRunFile | null> {
    let fileStamp: string;
    try {
      fileStamp = await productRunFileStamp(filePath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
    if (cached?.fileStamp === fileStamp) {
      return {
        run: cloneProductRun(cached.run),
        fileStamp
      };
    }
    const value = await readJsonFileIfPresent(filePath, label);
    if (value === null) return null;
    return {
      run: parseProductRunDocument(value, this.vaultId).run,
      fileStamp
    };
  }

  private rememberRun(loaded: LoadedProductRunFile): void {
    this.indexRun(loaded.run);
    this.runCache.set(loaded.run.productRunId, {
      run: cloneProductRun(loaded.run),
      fileStamp: loaded.fileStamp
    });
  }

  private indexRun(run: PiProductRunRecord): void {
    const next: ProductRunMetadataIndexEntry = {
      productRunId: run.productRunId,
      conversationId: run.conversationId,
      createdAt: run.createdAt
    };
    const previous = this.metadataById.get(run.productRunId);
    if (previous && previous.conversationId !== next.conversationId) {
      const previousIds = this.runIdsByConversation.get(
        previous.conversationId
      );
      previousIds?.delete(run.productRunId);
      if (previousIds?.size === 0) {
        this.runIdsByConversation.delete(previous.conversationId);
      }
    }
    this.metadataById.set(run.productRunId, next);
    const conversationIds = this.runIdsByConversation.get(next.conversationId)
      ?? new Set<string>();
    conversationIds.add(run.productRunId);
    this.runIdsByConversation.set(next.conversationId, conversationIds);
  }

  private removeIndexedRun(productRunId: string): void {
    const previous = this.metadataById.get(productRunId);
    if (previous) {
      const conversationIds = this.runIdsByConversation.get(
        previous.conversationId
      );
      conversationIds?.delete(productRunId);
      if (conversationIds?.size === 0) {
        this.runIdsByConversation.delete(previous.conversationId);
      }
    }
    this.metadataById.delete(productRunId);
    this.runCache.delete(productRunId);
  }

  private runFileName(productRunId: string): string {
    return `${stablePathToken(productRunId)}.json`;
  }

  private assertFileNameMatchesRun(
    name: string,
    run: PiProductRunRecord
  ): void {
    if (name === this.runFileName(run.productRunId)) return;
    throw new PiNativeFileStoreError(
      "store-corrupt",
      `ProductRun file ${name} 的文件名与记录身份不匹配`
    );
  }

  private async requireCatalogBinding(
    run: Pick<PiProductRunRecord, "conversationId" | "piSessionId">
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const entry = await this.catalog.get(run.conversationId);
    if (!entry) {
      throw new PiNativeFileStoreError(
        "not-found",
        `ProductRun 引用的 Conversation ${run.conversationId} 不存在`
      );
    }
    if (
      entry.vaultId !== this.vaultId
      || entry.piSessionId !== run.piSessionId
    ) {
      throw new PiNativeFileStoreError(
        "mapping-conflict",
        `ProductRun 的 Conversation / Vault / Pi Session 绑定不匹配`
      );
    }
    return entry;
  }

  private async writeRun(
    run: PiProductRunRecord
  ): Promise<PiProductRunRecord> {
    const document: ProductRunDocumentV1 = {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: this.vaultId,
      run: cloneProductRun(run)
    };
    const readback = await atomicWriteJsonFile(
      this.runFilePath(run.productRunId),
      document,
      `ProductRun ${run.productRunId}`,
      (value) => parseProductRunDocument(value, this.vaultId)
    );
    if (!isDeepStrictEqual(readback.run, run)) {
      throw new PiNativeFileStoreError(
        "readback-diverged",
        `ProductRun ${run.productRunId} 语义回读不一致`
      );
    }
    const fileStamp = await productRunFileStamp(this.runFilePath(
      run.productRunId
    ));
    this.rememberRun({
      run: readback.run,
      fileStamp
    });
    return readback.run;
  }
}

function compareProductRunIndexEntries(
  left: ProductRunMetadataIndexEntry,
  right: ProductRunMetadataIndexEntry
): number {
  return left.createdAt - right.createdAt
    || left.productRunId.localeCompare(right.productRunId);
}

async function productRunFileStamp(filePath: string): Promise<string> {
  const details = await stat(filePath);
  return [details.mtimeMs, details.ctimeMs, details.size].join(":");
}

function parseProductRunDocument(
  value: unknown,
  expectedVaultId: string
): ProductRunDocumentV1 {
  try {
    const object = requirePlainObject(value, "ProductRun document");
    requireExactKeys(
      object,
      ["schemaVersion", "vaultId", "run"],
      [],
      "ProductRun document"
    );
    if (object.schemaVersion !== PI_NATIVE_FILE_SCHEMA_VERSION) {
      throw new Error(`不支持 schemaVersion ${String(object.schemaVersion)}`);
    }
    if (object.vaultId !== expectedVaultId) {
      throw new Error("Vault identity 与目录不匹配");
    }
    return {
      schemaVersion: PI_NATIVE_FILE_SCHEMA_VERSION,
      vaultId: expectedVaultId,
      run: normalizeProductRun(object.run)
    };
  } catch (error) {
    if (
      error instanceof PiNativeFileStoreError
      && error.code === "store-corrupt"
    ) {
      throw error;
    }
    throw new PiNativeFileStoreError(
      "store-corrupt",
      `ProductRun document 校验失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeProductRun(value: unknown): PiProductRunRecord {
  const object = requirePlainObject(value, "ProductRun record");
  requireExactKeys(
    object,
    [
      "productRunId",
      "conversationId",
      "piSessionId",
      "userEntryId",
      "toolCallIds",
      "memoryMode",
      "state",
      "activeLeafId",
      "createdAt",
      "updatedAt"
    ],
    [
      "assistantEntryId",
      "permission",
      "terminalState",
      "agentSettledAt",
      "settledAt",
      "error",
      "memoryRecall",
      "knowledge",
      "maintenance"
    ],
    "ProductRun record"
  );
  if (!Array.isArray(object.toolCallIds)) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "productRun.toolCallIds 必须是数组"
    );
  }
  const toolCallIds = object.toolCallIds.map((toolCallId, index) =>
    requireNonEmptyString(toolCallId, `productRun.toolCallIds[${index}]`)
  );
  if (new Set(toolCallIds).size !== toolCallIds.length) {
    throw new PiNativeFileStoreError(
      "mapping-conflict",
      "productRun.toolCallIds 不得重复"
    );
  }
  const state = requireProductRunState(object.state);
  const createdAt = requireTimestamp(object.createdAt, "productRun.createdAt");
  const updatedAt = requireTimestamp(object.updatedAt, "productRun.updatedAt");
  if (updatedAt < createdAt) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "ProductRun updatedAt 不得早于 createdAt"
    );
  }
  const agentSettledAt = optionalTimestamp(
    object.agentSettledAt,
    "productRun.agentSettledAt"
  );
  const settledAt = optionalTimestamp(
    object.settledAt,
    "productRun.settledAt"
  );
  const terminalState = object.terminalState === undefined
    ? undefined
    : requireTerminalState(object.terminalState);
  if (STATE_RANK[state] >= STATE_RANK.agent_settled && agentSettledAt === undefined) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      `${state} 状态必须保存 agentSettledAt`
    );
  }
  if (
    state === "product_run_settled"
    && (terminalState === undefined || settledAt === undefined)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "product_run_settled 必须同时保存 terminalState 与 settledAt"
    );
  }
  if (settledAt !== undefined && state !== "product_run_settled") {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "settledAt 只能在 product_run_settled 状态保存"
    );
  }
  if (
    agentSettledAt !== undefined
    && (agentSettledAt < createdAt || agentSettledAt > updatedAt)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "agentSettledAt 必须位于 ProductRun 生命周期内"
    );
  }
  if (
    settledAt !== undefined
    && (
      settledAt < (agentSettledAt ?? createdAt)
      || settledAt > updatedAt
    )
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "settledAt 必须位于 agent settled 之后且不晚于 updatedAt"
    );
  }
  const activeLeafId = object.activeLeafId === null
    ? null
    : requireNonEmptyString(object.activeLeafId, "productRun.activeLeafId");
  const assistantEntryId = object.assistantEntryId === undefined
    ? undefined
    : requireNonEmptyString(
      object.assistantEntryId,
      "productRun.assistantEntryId"
    );
  const error = object.error === undefined
    ? undefined
    : requireNonEmptyString(object.error, "productRun.error");
  const memoryRecall = object.memoryRecall === undefined
    ? undefined
    : requireMemoryRecallObservation(object.memoryRecall);
  const knowledge = object.knowledge === undefined
    ? undefined
    : requireKnowledgeObservation(object.knowledge);
  return {
    productRunId: requireNonEmptyString(
      object.productRunId,
      "productRun.productRunId"
    ),
    conversationId: requireNonEmptyString(
      object.conversationId,
      "productRun.conversationId"
    ),
    piSessionId: requireNonEmptyString(
      object.piSessionId,
      "productRun.piSessionId"
    ),
    userEntryId: requireNonEmptyString(
      object.userEntryId,
      "productRun.userEntryId"
    ),
    ...(assistantEntryId ? { assistantEntryId } : {}),
    toolCallIds,
    memoryMode: requireMemoryMode(object.memoryMode),
    ...(object.permission === undefined ? {} : { permission: normalizePiWorkspacePermission(object.permission) }),
    state,
    ...(terminalState ? { terminalState } : {}),
    activeLeafId,
    ...(agentSettledAt !== undefined ? { agentSettledAt } : {}),
    ...(settledAt !== undefined ? { settledAt } : {}),
    ...(error ? { error } : {}),
    ...(memoryRecall ? { memoryRecall } : {}),
    ...(knowledge ? { knowledge } : {}),
    ...(object.maintenance === undefined ? {} : { maintenance: requireMaintenanceOutcome(object.maintenance) }),
    createdAt,
    updatedAt
  };
}

function definedUpdate(update: Readonly<PiProductRunUpdate>): PiProductRunUpdate {
  const output: PiProductRunUpdate = {};
  if (update.assistantEntryId !== undefined) {
    output.assistantEntryId = update.assistantEntryId;
  }
  if (update.toolCallIds !== undefined) output.toolCallIds = [...update.toolCallIds];
  if (update.state !== undefined) output.state = update.state;
  if (update.terminalState !== undefined) output.terminalState = update.terminalState;
  if (update.activeLeafId !== undefined) output.activeLeafId = update.activeLeafId;
  if (update.agentSettledAt !== undefined) output.agentSettledAt = update.agentSettledAt;
  if (update.settledAt !== undefined) output.settledAt = update.settledAt;
  if (update.error !== undefined) output.error = update.error;
  if (update.memoryRecall !== undefined) {
    output.memoryRecall = { ...update.memoryRecall };
  }
  if (update.maintenance !== undefined) output.maintenance = requireMaintenanceOutcome(update.maintenance);
  if (update.knowledge !== undefined) {
    output.knowledge = { ...update.knowledge };
  }
  return output;
}

function assertUpdateKeys(update: Readonly<PiProductRunUpdate>): void {
  const allowed = new Set([
    "assistantEntryId",
    "toolCallIds",
    "state",
    "terminalState",
    "activeLeafId",
    "agentSettledAt",
    "settledAt",
    "error",
    "memoryRecall",
    "knowledge",
    "maintenance",
    "updatedAt"
  ]);
  for (const key of Object.keys(update)) {
    if (!allowed.has(key)) {
      throw new PiNativeFileStoreError(
        "invalid-input",
        `ProductRun update 不允许字段 ${key}`
      );
    }
  }
}

function assertStateProgression(
  existing: PiProductRunRecord,
  candidate: PiProductRunRecord
): void {
  if (STATE_RANK[candidate.state] < STATE_RANK[existing.state]) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      `ProductRun 状态不得从 ${existing.state} 回退到 ${candidate.state}`
    );
  }
  if (
    existing.agentSettledAt !== undefined
    && candidate.agentSettledAt !== existing.agentSettledAt
  ) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "ProductRun 的 agentSettledAt 不可改写"
    );
  }
  if (
    existing.terminalState !== undefined
    && candidate.terminalState !== existing.terminalState
  ) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "ProductRun 的 terminalState 不可改写"
    );
  }
  if (
    existing.memoryRecall !== undefined
    && !isDeepStrictEqual(existing.memoryRecall, candidate.memoryRecall)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-transition",
      "ProductRun 的 Memory Recall 统计不可改写"
    );
  }
}

function hasTerminalMutation(
  existing: PiProductRunRecord,
  update: Readonly<PiProductRunUpdate>
): boolean {
  const candidate = {
    ...cloneProductRun(existing),
    ...definedUpdate(update),
    updatedAt: update.updatedAt ?? existing.updatedAt,
    toolCallIds: update.toolCallIds
      ? [...update.toolCallIds]
      : [...existing.toolCallIds]
  };
  return !isDeepStrictEqual(candidate, existing);
}

function requireProductRunState(value: unknown): PiProductRunState {
  if (
    typeof value !== "string"
    || !PRODUCT_RUN_STATES.has(value as PiProductRunState)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 ProductRun state ${String(value)}`
    );
  }
  return value as PiProductRunState;
}

function requireTerminalState(value: unknown): PiProductRunTerminalState {
  if (
    typeof value !== "string"
    || !PRODUCT_RUN_TERMINAL_STATES.has(value as PiProductRunTerminalState)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 ProductRun terminalState ${String(value)}`
    );
  }
  return value as PiProductRunTerminalState;
}

function requireMemoryMode(value: unknown): PiConversationMemoryMode {
  if (
    typeof value !== "string"
    || !MEMORY_MODES.has(value as PiConversationMemoryMode)
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      `不支持的 ProductRun memoryMode ${String(value)}`
    );
  }
  return value as PiConversationMemoryMode;
}

function requireMemoryRecallObservation(value: unknown): PiMemoryRecallObservation {
  const object = requirePlainObject(value, "productRun.memoryRecall");
  requireExactKeys(object, [
    "result",
    "stage",
    "elapsedMs",
    "scanned",
    "candidates",
    "injected",
    "remaining",
    "exhausted"
  ], [], "productRun.memoryRecall");
  if (
    !["completed", "skipped_no_memory", "failed"].includes(String(object.result))
    || !["loading", "catalog", "matching", "budgeting", "assembling"].includes(String(object.stage))
    || !Number.isSafeInteger(object.elapsedMs) || (object.elapsedMs as number) < 0
    || !Number.isSafeInteger(object.scanned) || (object.scanned as number) < 0
    || !Number.isSafeInteger(object.candidates) || (object.candidates as number) < 0
    || !Number.isSafeInteger(object.injected) || (object.injected as number) < 0
    || !Number.isSafeInteger(object.remaining) || (object.remaining as number) < 0
    || typeof object.exhausted !== "boolean"
    || (object.candidates as number) > (object.scanned as number)
    || (object.injected as number) > (object.candidates as number)
  ) {
    throw new PiNativeFileStoreError("invalid-input", "ProductRun Memory Recall 统计无效");
  }
  return Object.freeze({
    result: object.result as PiMemoryRecallObservation["result"],
    stage: object.stage as PiMemoryRecallObservation["stage"],
    elapsedMs: object.elapsedMs as number,
    scanned: object.scanned as number,
    candidates: object.candidates as number,
    injected: object.injected as number,
    remaining: object.remaining as number,
    exhausted: object.exhausted
  });
}

function requireMaintenanceOutcome(value: unknown): NonNullable<PiProductRunRecord["maintenance"]> {
  const object = requirePlainObject(value, "productRun.maintenance");
  requireExactKeys(object, ["analysisOnly", "processedSourcePaths", "pendingSourcePaths", "warnings"], [], "productRun.maintenance");
  if (typeof object.analysisOnly !== "boolean") throw new Error("Invalid maintenance analysis mode");
  const strings = (field: string): readonly string[] => {
    const values = object[field];
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string")) throw new Error(`Invalid maintenance ${field}`);
    return Object.freeze([...(values as string[])]);
  };
  return Object.freeze({ analysisOnly: object.analysisOnly, processedSourcePaths: strings("processedSourcePaths"), pendingSourcePaths: strings("pendingSourcePaths"), warnings: strings("warnings") });
}

function requireKnowledgeObservation(value: unknown): PiKnowledgeObservation {
  const object = requirePlainObject(value, "productRun.knowledge");
  requireExactKeys(object, [
    "workflow",
    "localRetrievalElapsedMs",
    "candidates",
    "returned",
    "remaining",
    "hasMore",
    "exhausted",
    "continuationCount",
    "knowledgeReadCount",
    "memoryRecallUsed",
    "memorySearchUsed",
    "memoryReadUsed",
    "conflictOrFreshnessTriggered"
  ], [
    "modelFirstTextLatencyMs",
    "protocolVersion",
    "preferenceProfileVersion",
    "preferenceState"
  ], "productRun.knowledge");
  const workflow = object.workflow;
  const numericFields = [
    "localRetrievalElapsedMs",
    "candidates",
    "returned",
    "remaining",
    "continuationCount",
    "knowledgeReadCount"
  ] as const;
  const booleanFields = [
    "hasMore",
    "exhausted",
    "memoryRecallUsed",
    "memorySearchUsed",
    "memoryReadUsed",
    "conflictOrFreshnessTriggered"
  ] as const;
  if (
    ![
      "chat",
      "ask",
      "maintain",
      "maintain_preview",
      "maintain_confirm"
    ].includes(String(workflow))
    || numericFields.some((field) =>
      !Number.isSafeInteger(object[field]) || (object[field] as number) < 0
    )
    || booleanFields.some((field) => typeof object[field] !== "boolean")
    || (object.returned as number) > (object.candidates as number)
    || (object.returned as number) + (object.remaining as number)
      > (object.candidates as number)
    || object.hasMore === object.exhausted
    || (
      object.modelFirstTextLatencyMs !== undefined
      && (
        !Number.isSafeInteger(object.modelFirstTextLatencyMs)
        || (object.modelFirstTextLatencyMs as number) < 0
      )
    )
    || (
      object.preferenceState !== undefined
      && object.preferenceState !== "default"
      && object.preferenceState !== "custom"
    )
    || (
      object.protocolVersion !== undefined
      && (
        typeof object.protocolVersion !== "string"
        || !safeVersionToken(object.protocolVersion)
      )
    )
    || (
      object.preferenceProfileVersion !== undefined
      && (
        typeof object.preferenceProfileVersion !== "string"
        || !safeVersionToken(object.preferenceProfileVersion)
      )
    )
    || (
      object.preferenceState !== undefined
      && object.preferenceProfileVersion === undefined
    )
  ) {
    throw new PiNativeFileStoreError(
      "invalid-input",
      "ProductRun Knowledge 诊断统计无效"
    );
  }
  return Object.freeze({
    workflow: workflow as PiKnowledgeObservation["workflow"],
    localRetrievalElapsedMs: object.localRetrievalElapsedMs as number,
    candidates: object.candidates as number,
    returned: object.returned as number,
    remaining: object.remaining as number,
    hasMore: object.hasMore as boolean,
    exhausted: object.exhausted as boolean,
    continuationCount: object.continuationCount as number,
    knowledgeReadCount: object.knowledgeReadCount as number,
    memoryRecallUsed: object.memoryRecallUsed as boolean,
    memorySearchUsed: object.memorySearchUsed as boolean,
    memoryReadUsed: object.memoryReadUsed as boolean,
    conflictOrFreshnessTriggered:
      object.conflictOrFreshnessTriggered as boolean,
    ...(object.modelFirstTextLatencyMs === undefined
      ? {}
      : { modelFirstTextLatencyMs: object.modelFirstTextLatencyMs as number }),
    ...(object.protocolVersion === undefined
      ? {}
      : { protocolVersion: object.protocolVersion }),
    ...(object.preferenceProfileVersion === undefined
      ? {}
      : { preferenceProfileVersion: object.preferenceProfileVersion }),
    ...(object.preferenceState === undefined
      ? {}
      : { preferenceState: object.preferenceState })
  });
}

function safeVersionToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value);
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requireTimestamp(value, label);
}

function cloneProductRun(run: Readonly<PiProductRunRecord>): PiProductRunRecord {
  return {
    productRunId: run.productRunId,
    conversationId: run.conversationId,
    piSessionId: run.piSessionId,
    userEntryId: run.userEntryId,
    ...(run.assistantEntryId ? { assistantEntryId: run.assistantEntryId } : {}),
    toolCallIds: [...run.toolCallIds],
    memoryMode: run.memoryMode,
    ...(run.permission === undefined ? {} : { permission: run.permission }),
    state: run.state,
    ...(run.terminalState ? { terminalState: run.terminalState } : {}),
    activeLeafId: run.activeLeafId,
    ...(run.agentSettledAt !== undefined
      ? { agentSettledAt: run.agentSettledAt }
      : {}),
    ...(run.settledAt !== undefined ? { settledAt: run.settledAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.memoryRecall ? { memoryRecall: { ...run.memoryRecall } } : {}),
    ...(run.knowledge ? { knowledge: { ...run.knowledge } } : {}),
    ...(run.maintenance ? { maintenance: requireMaintenanceOutcome(run.maintenance) } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}
