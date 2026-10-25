import { renderCanonicalMemoryExport, serializeCanonicalMemoryRecord, parseCanonicalMemoryRecord, CanonicalMemoryFormatError, PersonalMemoryIdentityMismatchError, parseCanonicalMemoryManifest } from "./personal-memory-core";
import { renderPersonalMemoryOverview as renderOverview } from "./mobile-profile-protocol";
import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher, type Stats } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  PERSONAL_MEMORY_SCHEMA,
  SECONDARY_MEMORY_SCHEMA,
  type PersonalMemoryBasis,
  type PersonalMemoryContentOrigin,
  type PersonalMemoryKind,
  type PersonalMemoryRecord,
  type PersonalMemoryRuntimeContext,
  type PersonalMemorySearchItem,
  type PersonalMemorySearchRequest,
  type PersonalMemorySearchResult,
  type PersonalMemoryWriteRequest,
  type PersonalMemoryWriteResult,
  type UserProfileControlSaveRequest,
  type UserProfileControlDeleteRequest,
  type UserProfileControlMutationResult,
  type SecondaryMatchView,
  type SecondaryMemoryRecord
} from "./personal-memory-contracts";
import {
  applySecondaryHit,
  indexableSecondaryRecords,
  normalizeAssociationClueFields,
  serializeSecondaryRecord
} from "./secondary-memory-store";
import {
  buildSearchIndexV3,
  indexChecksum,
  lexicalTokens,
  scorePrimaryEntry,
  scoreSecondaryEntry,
  type BuildIndexCatalogInput,
  type SearchIndexV3,
  type SecondaryCatalogEntry
} from "./search-index-v3";
import {
  applyDreamProfileUpdate,
  emptyUserProfileState,
  profileSlotDefinition,
  rebindProfileSource,
  reconcileProfileSources,
  USER_PROFILE_ITEM_HARD_MAX_CHARS,
  userProfileStateJson,
  UserProfileStateStore,
  type UserProfileControlSnapshot,
  type UserProfileState
} from "./user-profile-state";
import {
  renderUserMarkdown,
  projectedProfileItems
} from "./cognitive-projection";
import {
  USER_MD_HARD_MAX_BYTES
} from "./agent-self";
import { normalizeTextForDedupe } from "./cognitive-file-utils";
import {
  invalidatedMemoryProductRunIds,
  productRunIdFromExperienceProfileSourceId,
  productRunIdFromMemorySource
} from "./dream-source-group";

const MAX_OVERVIEW_CHARS = 20_000;
const MAX_RECORD_CONTENT_CHARS = 24_000;
const MAX_SEARCH_LIMIT = 50;
const MAX_CURSOR_CHARS = 4_096;
const GENERATED_OVERVIEW_SENTINEL = "这是有上限的当前导航；完整内容按需通过 memory_search / memory_read 读取。";
const SAFE_ID = /^[a-zA-Z0-9_-]{3,96}$/u;
const MUTATION_AUDIT_TYPES = new Set([
  "created",
  "superseded",
  "closed",
  "profile_updated",
  "forgotten"
]);
const MAINTENANCE_AUDIT_TYPES = new Set([
  "identity_file_updated",
  "exported",
  "forget_restored",
  "source_deleted",
  "runtime_rebuilt_from_markdown",
  "external_markdown_reconciled",
  "cognitive_update",
  "secondary_memory_updated"
]);
const mutationLanes = new Map<string, Promise<unknown>>();

export interface PersonalMemoryRepositoryOptions {
  readonly vaultPath: string;
  readonly vaultId: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** Test-only after-change seam for crash recovery and live transaction barriers. */
  readonly failTransactionAfterChange?: (
    operation: string,
    appliedChanges: number
  ) => boolean | Promise<boolean>;
  /**
   * Optional provider of current secondary (二级事实) records so Search Index v3
   * can fold them into the derived index. Cognitive system wires this in
   * production; tests may inject fixtures. Defaults to no secondary records.
   */
  readonly secondaryRecordsProvider?: () => Promise<readonly SecondaryMemoryRecord[]>;
  /**
   * Lifecycle hook keeping secondary facts in sync with supersede / forget /
   * restore / close. Returns the full secondary record list after the change
   * plus the files that must be written inside the same transaction.
   */
  readonly secondaryLifecycle?: (input: Readonly<{
    operation: "supersede" | "forget" | "restore" | "close";
    parentId: string;
  }>) => Promise<Readonly<{
    records: readonly SecondaryMemoryRecord[];
    changedFiles: readonly Readonly<{ relativePath: string; content: string }>[];
  }>>;
  /** Fired after a create/supersede/restore transaction commits (dream queue). */
  readonly onMemoryCommitted?: (event: Readonly<{
    operation: "create" | "supersede" | "restore";
    recordId: string;
    revision: number;
  }>) => void;
  /** Test-only deterministic barrier for external watcher callbacks. */
  readonly watchExternalChanges?: boolean;
}

interface CognitiveUpdateInput {
  readonly userContent?: string;
  readonly secondaryRecords: readonly SecondaryMemoryRecord[];
  readonly extraChanges: readonly Readonly<{ relativePath: string; content?: string }>[];
  readonly detail: string;
  readonly expectedMemoryRevision?: number;
  readonly expectedUserProjectionHash?: string;
}

export type PersonalMemoryExternalChange =
  | Readonly<{ event: "change"; relativePath: string }>
  | Readonly<{ event: "rename" | "unknown" | "listener_error"; relativePath?: string }>;

export interface PersonalMemoryRecallRuntimeContext {
  readonly vaultId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly memoryMode: "normal";
}

export interface PersonalMemoryLayout {
  readonly root: string;
  readonly agent: string;
  readonly sharedUser: string;
  readonly user: string;
  readonly memory: string;
  readonly history: string;
  readonly facts: string;
  readonly views: string;
  readonly decisions: string;
  readonly active: string;
  readonly episodes: string;
  readonly runtime: string;
  readonly manifest: string;
  readonly searchIndex: string;
  readonly audit: string;
  readonly sourceMap: string;
  readonly transactions: string;
  readonly backups: string;
  readonly secondary: string;
  readonly personalityState: string;
  readonly agentSelfMetadata: string;
  readonly userProfileState: string;
  readonly agentIdentity: string;
  readonly dreamState: string;
  readonly dreamExperienceInbox: string;
}

export interface PersonalMemoryAuditObservation {
  readonly lineNumber: number;
  readonly type: string;
  readonly revision: number;
  readonly at: number;
  readonly productRunId: string;
  readonly toolCallId?: string;
}

export type PersonalMemoryAuditInspection =
  | Readonly<{
      status: "complete";
      events: readonly Readonly<PersonalMemoryAuditObservation>[];
    }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "invalid"; invalidLine?: number }>;

interface ManifestRecord extends Omit<PersonalMemoryRecord, "content"> {
  readonly contentHash?: string;
}

interface PersonalMemoryFixedFileHashes {
  readonly agent: string;
  readonly user: string;
}

interface PersonalMemoryTombstone {
  readonly recordId: string;
  readonly forgottenAt: number;
  readonly reason: string;
  readonly backupFile: string;
  readonly source: string;
}

interface PersonalMemoryManifest {
  readonly schemaVersion: 1;
  readonly vaultId: string;
  revision: number;
  records: ManifestRecord[];
  tombstones: PersonalMemoryTombstone[];
  updatedAt: number;
  fixedFileHashes?: PersonalMemoryFixedFileHashes;
}

export interface PersonalMemoryTurnSnapshot {
  readonly revision: number;
  readonly scanned: number;
  readonly agent: string;
  readonly user: string | null;
  readonly memory: string | null;
  readonly injectionKeys: readonly string[];
  readonly search: Readonly<PersonalMemoryTurnSearchResult> | null;
}

export type PersonalMemoryTurnCatalogCandidate = Pick<PersonalMemorySearchItem,
  "id" | "kind" | "status" | "title" | "recallWhen" | "summary" | "date" | "basis" | "sourceSummary" | "scope" | "score"
  | "contentOrigin" | "asOf" | "supersedes" | "supersededRecord" | "revision" | "file"
> & Readonly<{
  /**
   * 该一级记忆命中查询的全部二级事实（Recall PRD §12）：预算选择必须
   * 按「一级候选 + 这些二级事实」的最终注入形态计算 Token。
   */
  secondaryMatches?: readonly SecondaryMatchView[];
}>;

export interface PersonalMemoryTurnSearchResult {
  readonly revision: number;
  readonly total: number;
  readonly returned: number;
  readonly remaining: number;
  readonly exhausted: boolean;
  readonly items: readonly Readonly<PersonalMemorySearchItem>[];
  /** Secondary facts that decisively pulled their parent into the candidates. */
  readonly pendingSecondaryHits: readonly Readonly<{ secondaryId: string; parentId: string }>[];
}

type SearchIndex = SearchIndexV3;

interface SourceMapFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly sources: Readonly<Record<string, readonly string[]>>;
}

interface TransactionChange {
  readonly relativePath: string;
  readonly content?: string;
}

interface ProjectionReconciliation {
  readonly changes: readonly TransactionChange[];
  readonly userHash?: string;
}

interface TransactionPlanEntry {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly backupFile?: string;
}

interface TransactionPlan {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly operation: string;
  readonly baseRevision: number;
  readonly targetRevision: number;
  readonly entries: readonly TransactionPlanEntry[];
}

export class PersonalMemoryAccessError extends Error {
  constructor(
    readonly code:
      | "vault_mismatch"
      | "no_memory"
      | "invalid_request"
      | "not_found"
      | "revision_conflict"
      | "unsafe_path",
    message: string
  ) {
    super(message);
    this.name = "PersonalMemoryAccessError";
  }
}

export class PersonalMemoryRepository {
  readonly layout: PersonalMemoryLayout;
  private readonly vaultPath: string;
  private readonly vaultId: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly failTransactionAfterChange?: (
    operation: string,
    appliedChanges: number
  ) => boolean | Promise<boolean>;
  private readonly watchExternalChanges: boolean;
  private disposed = false;
  private initialization: Promise<Readonly<PersonalMemoryLayout>> | null = null;
  private manifestCache: PersonalMemoryManifest | null = null;
  private recordsCache: readonly PersonalMemoryRecord[] | null = null;
  private searchIndexCache: Readonly<SearchIndex> | null = null;
  private fixedContextCache: Readonly<{ agent: string; user: string; memory: string }> | null = null;
  private sourceDirectoryRefreshPending = false;
  private sourceDirectoryRefreshRunning: Promise<void> | null = null;
  private readonly externalWatchers: FSWatcher[] = [];
  private readonly internalWatchExpectations = new Map<
    string,
    Readonly<{ hash: string | null; until: number }>
  >();
  private secondaryCache: readonly SecondaryMemoryRecord[] = [];
  private readonly secondaryRecordsProvider?: () => Promise<readonly SecondaryMemoryRecord[]>;
  private secondaryRefreshProvider?: () => Promise<readonly SecondaryMemoryRecord[]>;
  private secondaryLifecycleHook?: (input: Readonly<{
    operation: "supersede" | "forget" | "restore" | "close";
    parentId: string;
  }>) => Promise<Readonly<{
    records: readonly SecondaryMemoryRecord[];
    changedFiles: readonly Readonly<{ relativePath: string; content: string }>[];
  }>>;
  private onMemoryCommittedHook?: (event: Readonly<{
    operation: "create" | "supersede" | "restore";
    recordId: string;
    revision: number;
  }>) => void;
  private secondaryChangedHook?: (records: readonly SecondaryMemoryRecord[]) => void;

  constructor(options: Readonly<PersonalMemoryRepositoryOptions>) {
    this.vaultPath = path.resolve(options.vaultPath);
    this.vaultId = cleanRequired(options.vaultId, "vaultId", 256);
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `mem_${randomUUID().replaceAll("-", "")}`);
    this.failTransactionAfterChange = options.failTransactionAfterChange;
    this.watchExternalChanges = options.watchExternalChanges ?? true;
    this.secondaryRecordsProvider = options.secondaryRecordsProvider;
    this.secondaryLifecycleHook = options.secondaryLifecycle;
    this.onMemoryCommittedHook = options.onMemoryCommitted;
    const root = path.join(this.vaultPath, ".echoink");
    const sharedUser = path.join(root, "shared-user");
    const history = path.join(sharedUser, "memory");
    const runtime = path.join(sharedUser, ".runtime");
    this.layout = Object.freeze({
      root,
      agent: path.join(root, "agents", "echoink", "AGENT.md"),
      sharedUser,
      user: path.join(sharedUser, "USER.md"),
      memory: path.join(sharedUser, "MEMORY.md"),
      history,
      facts: path.join(history, "facts"),
      views: path.join(history, "views"),
      decisions: path.join(history, "decisions"),
      active: path.join(history, "active"),
      episodes: path.join(history, "episodes"),
      runtime,
      manifest: path.join(runtime, "manifest.json"),
      searchIndex: path.join(runtime, "search-index.json"),
      audit: path.join(runtime, "audit.jsonl"),
      sourceMap: path.join(runtime, "source-map.json"),
      transactions: path.join(runtime, "transactions"),
      backups: path.join(runtime, "backups"),
      secondary: path.join(history, "secondary"),
      personalityState: path.join(root, "agents", "echoink", "personality-state.json"),
      agentSelfMetadata: path.join(root, "agents", "echoink", "agent-self-meta.json"),
      userProfileState: path.join(sharedUser, "user-profile-state.json"),
      agentIdentity: path.join(root, "agents", "echoink", "agent-identity.json"),
      dreamState: path.join(runtime, "dream-state.json"),
      dreamExperienceInbox: path.join(runtime, "dream-experience-inbox.json")
    });
    for (const key of Object.keys(this.layout) as Array<keyof PersonalMemoryLayout>) {
      this.assertManagedPath(this.layout[key]);
    }
  }

  async initialize(): Promise<Readonly<PersonalMemoryLayout>> {
    if (this.disposed) throw new PersonalMemoryAccessError("invalid_request", "Personal Memory Repository is disposed");
    await this.assertNoMobileTransactions();
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    const layout = await this.initialization;
    await this.consumePendingSourceDirectoryRefresh();
    return layout;
  }

  /** Recover existing storage transactions before identity inventory, without creating memory or reconciling it. */
  async recoverStorageTransactions(): Promise<void> {
    if (!await pathExists(this.layout.root)) return;
    await this.assertManagedTreeSafe();
    await this.assertNoMobileTransactions();
    if (await pathExists(this.layout.transactions)) await this.recoverPendingTransactions();
  }

  private async initializeOnce(): Promise<Readonly<PersonalMemoryLayout>> {
    await mkdir(this.vaultPath, { recursive: true });
    for (const component of [
      this.layout.root,
      this.layout.sharedUser,
      this.layout.history,
      this.layout.runtime
    ]) {
      await this.assertNotSymlink(component);
    }
    for (const directory of [
      this.layout.sharedUser,
      this.layout.facts,
      this.layout.views,
      this.layout.decisions,
      this.layout.active,
      this.layout.episodes,
      this.layout.secondary,
      this.layout.runtime,
      this.layout.transactions,
      this.layout.backups
    ]) {
      await this.assertNotSymlink(directory);
      await mkdir(directory, { recursive: true });
    }
    await this.assertManagedTreeSafe();
    await this.recoverPendingTransactions();
    await writeIfMissing(this.layout.user, defaultUserProfile());
    await writeIfMissing(this.layout.memory, defaultMemoryOverview());
    await writeIfMissing(this.layout.audit, "");
    if (this.secondaryRecordsProvider) {
      this.secondaryCache = [...(await this.secondaryRecordsProvider())];
    }
    await this.assertManagedTreeSafe();
    await this.reconcileMarkdownTruth();
    await this.hydrateCachesFromDisk();
    if (this.watchExternalChanges) this.startExternalWatchers();
    return this.layout;
  }

  /**
   * External-edit entrypoint used by the bounded filesystem listeners and by
   * deterministic tests. A known change refreshes one file. Rename/unknown
   * events and listener errors merely schedule one primary-source scan for the
   * next access; they never block the foreground Chat path.
   */
  async handleExternalChange(input: PersonalMemoryExternalChange): Promise<void> {
    if (this.disposed) return;
    if (input.event !== "change") {
      this.sourceDirectoryRefreshPending = true;
      return;
    }
    const relativePath = normalizeManagedRelativePath(input.relativePath);
    if (!this.isKnownExternalPath(relativePath)) {
      this.sourceDirectoryRefreshPending = true;
      return;
    }
    if (!this.initialization) {
      this.sourceDirectoryRefreshPending = true;
      return;
    }
    try {
      await this.initialization;
      await this.withMutation(async () => {
        if (this.disposed) return;
        if (relativePath === "shared-user/USER.md") {
          await this.refreshKnownFixedFile(relativePath);
        } else {
          await this.refreshKnownPrimaryRecord(relativePath);
        }
      });
    } catch {
      this.sourceDirectoryRefreshPending = true;
    }
  }

  private async consumePendingSourceDirectoryRefresh(): Promise<void> {
    if (this.disposed) return;
    if (this.sourceDirectoryRefreshRunning) {
      await this.sourceDirectoryRefreshRunning;
      return;
    }
    if (!this.sourceDirectoryRefreshPending) return;
    this.sourceDirectoryRefreshPending = false;
    const refresh = this.withMutation(async () => {
      await this.refreshPrimarySourceDirectories();
    }).catch(() => {
      // Listener recovery is best effort. Keep the last known-good cache so a
      // damaged external file or transient watcher failure never blocks Chat.
    }).finally(() => {
      if (this.sourceDirectoryRefreshRunning === refresh) {
        this.sourceDirectoryRefreshRunning = null;
      }
    });
    this.sourceDirectoryRefreshRunning = refresh;
    await refresh;
  }

  private startExternalWatchers(): void {
    if (this.disposed || this.externalWatchers.length > 0) return;
    const watchDirectory = (
      directory: string,
      toRelativePath: (filename: string) => string | null,
      renameNeedsSourceScan: boolean
    ): void => {
      try {
        const watcher = watch(directory, { persistent: false, encoding: "utf8" }, (event, filename) => {
          if (this.disposed) return;
          if (typeof filename !== "string" || !filename) {
            this.sourceDirectoryRefreshPending = true;
            return;
          }
          const relativePath = toRelativePath(filename);
          if (!relativePath) return;
          void this.isExpectedInternalWatchEcho(relativePath).then((internalEcho) => {
            if (this.disposed || internalEcho) return;
            if (event === "rename" && renameNeedsSourceScan) {
              this.sourceDirectoryRefreshPending = true;
              return;
            }
            void this.handleExternalChange({ event: "change", relativePath });
          }).catch(() => {
            this.sourceDirectoryRefreshPending = true;
          });
        });
        watcher.on("error", () => {
          if (this.disposed) return;
          this.sourceDirectoryRefreshPending = true;
        });
        watcher.unref();
        this.externalWatchers.push(watcher);
      } catch {
        this.sourceDirectoryRefreshPending = true;
      }
    };

    for (const [directory, kind] of [
      [this.layout.facts, "facts"],
      [this.layout.views, "views"],
      [this.layout.decisions, "decisions"],
      [this.layout.active, "active"],
      [this.layout.episodes, "episodes"]
    ] as const) {
      watchDirectory(directory, (filename) =>
        filename.endsWith(".md")
          ? path.posix.join("shared-user", "memory", kind, filename)
          : null, true);
    }
    watchDirectory(this.layout.sharedUser, (filename) =>
      filename === "USER.md" ? "shared-user/USER.md" : null, false);
  }

  /** Permanently stop this Repository instance and drain its current lane. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const watcher of this.externalWatchers.splice(0)) watcher.close();
    this.sourceDirectoryRefreshPending = false;
    this.internalWatchExpectations.clear();
    await mutationLanes.get(this.layout.root)?.catch(() => undefined);
  }

  private isKnownExternalPath(relativePath: string): boolean {
    if (relativePath === "shared-user/USER.md") return true;
    return /^(?:shared-user\/memory\/(?:facts|views|decisions|active|episodes)\/[a-zA-Z0-9_-]{3,96}\.md)$/u
      .test(relativePath);
  }

  private async isExpectedInternalWatchEcho(relativePath: string): Promise<boolean> {
    const expected = this.internalWatchExpectations.get(relativePath);
    if (!expected) return false;
    if (Date.now() > expected.until) {
      this.internalWatchExpectations.delete(relativePath);
      return false;
    }
    const target = this.absoluteFromRelative(relativePath);
    if (expected.hash === null) return !(await pathExists(target));
    try {
      return contentHash(await readFile(target, "utf8")) === expected.hash;
    } catch {
      return false;
    }
  }

  async loadFixedContext(input: Readonly<{
    memoryMode: "normal" | "no_memory";
  }>): Promise<Readonly<{
    revision: number;
    agent: string;
    user: string | null;
    memory: string | null;
    injectionKeys: readonly string[];
  }>> {
    if (input.memoryMode === "no_memory") return await this.loadNoMemoryContext();
    await this.initialize();
    return await this.withMutation(async () => {
      const manifest = await this.readManifest();
      return await this.loadFixedContextSnapshot(manifest, input.memoryMode);
    });
  }

  /**
   * Loads one immutable turn snapshot after a single initialization pass.
   * Fixed files, the v2 catalog, ranking, and selected record reads are all
   * bound to the same manifest revision inside the repository mutation lane.
   */
  async prepareTurnSnapshot(
    input: Readonly<{
      memoryMode: "normal" | "no_memory";
      query?: string;
      scope?: PersonalMemorySearchRequest["scope"];
      statuses?: PersonalMemorySearchRequest["statuses"];
      from?: PersonalMemorySearchRequest["from"];
      to?: PersonalMemorySearchRequest["to"];
      selectCandidateIds?(
        candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
      ): readonly string[];
    }>,
    runtime?: Readonly<PersonalMemoryRecallRuntimeContext>
  ): Promise<Readonly<PersonalMemoryTurnSnapshot>> {
    if (input.memoryMode === "no_memory") return await this.loadNoMemoryTurnSnapshot();
    if (input.memoryMode === "normal") {
      if (!runtime) {
        throw new PersonalMemoryAccessError("invalid_request", "Personal Memory turn runtime is required");
      }
      this.assertRecallRuntime(runtime);
    }
    await this.initialize();
    return await this.withMutation(async () => {
      const manifest = await this.readManifest();
      const fixed = await this.loadFixedContextSnapshot(manifest, input.memoryMode);
      const index = await this.readSearchIndexSnapshot(manifest);
      const search = await this.prepareTurnSearchSnapshot(
        { ...input, query: input.query ?? "" },
        manifest,
        index,
        input.selectCandidateIds
      );
      return Object.freeze({ ...fixed, scanned: index.catalog.length, search });
    });
  }

  /** Reads and validates only the manifest identity; it never exposes Memory content. */
  async readVaultId(): Promise<string> {
    return (await this.readManifest()).vaultId;
  }

  /**
   * Reads only linkage metadata from audit.jsonl. It never returns Memory
   * content, Tool payloads, queries, exception text, or source URLs.
   */
  async readAuditByProductRun(
    productRunId: string
  ): Promise<readonly Readonly<PersonalMemoryAuditObservation>[]> {
    const inspection = await this.inspectAuditByProductRun(productRunId);
    if (inspection.status === "missing") {
      throw new Error("personal_memory_audit_missing");
    }
    if (inspection.status === "invalid") {
      throw new Error(
        inspection.invalidLine === undefined
          ? "personal_memory_audit_invalid"
          : `personal_memory_audit_invalid_line_${inspection.invalidLine}`
      );
    }
    return inspection.events;
  }

  async inspectAuditByProductRun(
    productRunId: string
  ): Promise<PersonalMemoryAuditInspection> {
    const expected = cleanRequired(productRunId, "productRunId", 512);
    const observations: PersonalMemoryAuditObservation[] = [];
    let text: string;
    try {
      text = await readFile(this.layout.audit, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? Object.freeze({ status: "missing" as const })
        : Object.freeze({ status: "invalid" as const });
    }
    const lines = text.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return Object.freeze({ status: "invalid" as const, invalidLine: index + 1 });
        }
        const event = parsed as Record<string, unknown>;
        const eventType = typeof event.type === "string" ? event.type : "";
        const mutation = MUTATION_AUDIT_TYPES.has(eventType);
        const maintenance = MAINTENANCE_AUDIT_TYPES.has(eventType);
        if (
          !eventType.trim()
          || eventType.length > 160
          || (!mutation && !maintenance)
          || !Number.isSafeInteger(event.revision)
          || (event.revision as number) < 0
          || !Number.isSafeInteger(event.at)
          || (event.at as number) < 0
          || (mutation && event.source === undefined)
          || (
            event.source !== undefined
            && !(
              typeof event.source === "string"
              && event.source.trim()
              && event.source.length <= 2_000
            )
          )
          || (
            event.toolCallId !== undefined
            && !(
              typeof event.toolCallId === "string"
              && event.toolCallId.trim()
              && event.toolCallId.length <= 512
            )
          )
        ) {
          return Object.freeze({ status: "invalid" as const, invalidLine: index + 1 });
        }
        const sourceProductRunId = typeof event.source === "string"
          ? productRunIdFromRuntimeSource(event.source)
          : null;
        if (event.toolCallId !== undefined && sourceProductRunId === null) {
          return Object.freeze({ status: "invalid" as const, invalidLine: index + 1 });
        }
        if (sourceProductRunId !== expected) continue;
        const toolCallId = typeof event.toolCallId === "string"
          ? event.toolCallId
          : undefined;
        observations.push(Object.freeze({
          lineNumber: index + 1,
          type: eventType,
          revision: event.revision as number,
          at: event.at as number,
          productRunId: expected,
          ...(toolCallId ? { toolCallId } : {})
        }));
      } catch {
        return Object.freeze({ status: "invalid" as const, invalidLine: index + 1 });
      }
    }
    return Object.freeze({
      status: "complete" as const,
      events: Object.freeze(observations)
    });
  }

  async write(
    request: PersonalMemoryWriteRequest,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    this.assertRuntime(runtime);
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedPathsSafe([this.layout.manifest, this.layout.audit]);
      await this.refreshPrimaryCachesBeforeWrite();
      if (request.operation === "supersede"
        || request.operation === "close"
        || request.operation === "forget") {
        await this.reconcilePrimaryTargetsBeforeMutation([request.targetId]);
      } else if (request.operation === "profile_update" && request.targetId) {
        await this.reconcilePrimaryTargetsBeforeMutation([request.targetId]);
      }
      const manifest = await this.readManifest();
      const records = await this.readAllRecords(manifest);
      if (request.operation === "create") {
        validateWriteContent(
          request.kind,
          request.basis,
          request.contentOrigin,
          runtime.explicitlyAuthorized === true
        );
        const duplicate = this.classifyCreateDuplicate(records, request);
        if (duplicate) {
          return Object.freeze({
            revision: manifest.revision,
            record: duplicate.record,
            status: duplicate.status
          });
        }
      }
      assertExpectedRevision(manifest, request.expectedRevision);
      if (request.operation === "profile_update") {
        await this.assertFixedFilesMatchManifest(manifest);
      }
      switch (request.operation) {
        case "create":
          return await this.createRecord(manifest, records, request, runtime);
        case "supersede":
          return await this.supersedeRecord(manifest, records, request, runtime);
        case "close":
          return await this.closeRecord(manifest, records, request, runtime);
        case "profile_update":
          return await this.updateUserProfile(manifest, records, request, runtime);
        case "forget":
          return await this.forgetRecord(manifest, records, request, runtime);
      }
    });
  }

  private classifyCreateDuplicate(
    records: readonly PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "create" }>
  ): Readonly<{
    status: "idempotent" | "possible_duplicate";
    record: PersonalMemoryRecord;
  }> | null {
    const semantics = normalizeCreateSemantics(request);
    const broadKey = primaryBroadKey(semantics.kind, semantics.title, semantics.scope);
    const existing = records.find((record) =>
      record.status === "current"
      && primaryBroadKey(record.kind, record.title, record.scope) === broadKey
    );
    if (!existing) return null;
    return Object.freeze({
      status: sameCreateSemantics(existing, semantics)
        ? "idempotent"
        : "possible_duplicate",
      record: existing
    });
  }

  async search(
    request: Readonly<PersonalMemorySearchRequest>,
    runtime: Readonly<PersonalMemoryRuntimeContext>,
    options: Readonly<{ maxResultChars?: number }> = {}
  ): Promise<Readonly<PersonalMemorySearchResult>> {
    this.assertRuntime(runtime);
    await this.initialize();
    return await this.withMutation(async () => {
      const manifest = await this.readManifest();
      const index = await this.readSearchIndexSnapshot(manifest);
      return await this.searchSnapshot(request, manifest, index, options);
    });
  }

  private async searchSnapshot(
    request: Readonly<PersonalMemorySearchRequest>,
    manifest: PersonalMemoryManifest,
    index: Readonly<SearchIndex>,
    options: Readonly<{ maxResultChars?: number }> = {}
  ): Promise<Readonly<PersonalMemorySearchResult>> {
    const query = cleanOptional(request.query, "query", 2_000) ?? "";
    const queryTokens = lexicalTokens(query);
    const browseAll = query.length === 0;
    const queryTokenSet = new Set(queryTokens);
    const secondaryBest = bestSecondaryScores(index, query, queryTokenSet);
    const normalizedStatuses = [...new Set(request.statuses ?? ["current"])].sort(compareText);
    const normalizedKinds = request.kinds
      ? [...new Set(request.kinds)].sort(compareText)
      : [];
    const statuses = new Set(normalizedStatuses);
    const kinds = normalizedKinds.length ? new Set(normalizedKinds) : null;
    const scope = request.scope?.trim().toLocaleLowerCase();
    const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, request.limit ?? 12));
    const fingerprint = contentHash(stableJson({
      query: query.normalize("NFKC").toLocaleLowerCase(),
      kinds: normalizedKinds,
      scope: scope ?? null,
      statuses: normalizedStatuses,
      from: request.from ?? null,
      to: request.to ?? null
    }));
    const offset = request.cursor
      ? decodeSearchCursor(request.cursor, manifest.revision, fingerprint)
      : 0;
    const ranked = index.catalog
      .filter((record) => statuses.has(record.status))
      .filter((record) => !kinds || kinds.has(record.kind))
      .filter((record) => !scope || record.scope?.toLocaleLowerCase() === scope)
      .filter((record) => !request.from || record.date >= request.from)
      .filter((record) => !request.to || record.date <= request.to)
      .map((record) => {
        const primaryScore = scorePrimaryEntry(record, query, queryTokenSet);
        const secondary = secondaryBest.get(record.id);
        return {
          record,
          primaryScore,
          secondary,
          score: primaryScore + (secondary?.score ?? 0)
        };
      })
      .filter((entry) => browseAll || (queryTokens.length > 0 && entry.score > 0))
      .sort((left, right) =>
        right.score - left.score
        || right.record.date.localeCompare(left.record.date)
        || left.record.id.localeCompare(right.record.id)
      );
    if (offset > ranked.length) {
      throw new PersonalMemoryAccessError("invalid_request", "memory_search cursor offset is invalid");
    }
    const selected = ranked.slice(offset, offset + limit);
    const metadataById = new Map(manifest.records.map((record) => [record.id, record]));
    const items = await Promise.all(selected.map(async ({ record, score, secondary }) => {
      const metadata = metadataById.get(record.id);
      if (!metadata) {
        throw new PersonalMemoryAccessError("invalid_request", "memory_search index contains an unavailable record");
      }
      const full = await this.readRecord(metadata);
      return Object.freeze({
        id: record.id,
        kind: record.kind,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: summarize(full.content),
        date: record.date,
        ...searchItemIdentity(full),
        score,
        ...(secondary ? { matchedSecondaryId: secondary.entry.id } : {})
      });
    }));
    const total = ranked.length;
    let returned = items.length;
    const maxResultChars = options.maxResultChars ?? Number.POSITIVE_INFINITY;
    const resultFor = (count: number): PersonalMemorySearchResult => {
      const remaining = total - offset - count;
      return Object.freeze({
        revision: manifest.revision,
        total,
        returned: count,
        remaining,
        exhausted: remaining === 0,
        nextCursor: remaining === 0
          ? null
          : encodeSearchCursor(manifest.revision, fingerprint, offset + count),
        items: Object.freeze(items.slice(0, count))
      });
    };
    while (returned > 1 && JSON.stringify(resultFor(returned)).length > maxResultChars) {
      returned -= 1;
    }
    const result = resultFor(returned);
    if (JSON.stringify(result).length > maxResultChars) {
      throw new PersonalMemoryAccessError("invalid_request", "memory_search result budget is too small");
    }
    return result;
  }

  private async prepareTurnSearchSnapshot(
    request: Readonly<Pick<PersonalMemorySearchRequest, "query" | "scope" | "statuses" | "from" | "to">>,
    manifest: PersonalMemoryManifest,
    index: Readonly<SearchIndex>,
    selectCandidateIds: ((
      candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
    ) => readonly string[]) | undefined
  ): Promise<Readonly<PersonalMemoryTurnSearchResult>> {
    const query = cleanOptional(request.query, "query", 2_000) ?? "";
    const queryTokens = lexicalTokens(query);
    const browseAll = query.length === 0;
    const queryTokenSet = new Set(queryTokens);
    const secondaryBest = bestSecondaryScores(index, query, queryTokenSet);
    const secondaryMatches = groupSecondaryMatches(index, query, queryTokenSet);
    const metadataById = new Map(manifest.records.map((record) => [record.id, record]));
    const cachedRecordsById = new Map(this.recordsCache?.map((record) => [record.id, record]) ?? []);
    const secondaryById = new Map(this.secondaryCache.map((record) => [record.id, record]));
    const forgottenIds = new Set(manifest.tombstones.map((entry) => entry.recordId));
    const scope = cleanOptional(request.scope, "scope", 240)?.toLocaleLowerCase();
    const namedProjects = new Set<string>();
    // Explicit scope takes precedence. Otherwise only project: scopes supply
    // names, matched literally against the query already built by the Harness.
    if (!scope) {
      const normalizedQuery = query.toLocaleLowerCase();
      for (const record of index.catalog) {
        const recordScope = record.scope?.trim().toLocaleLowerCase();
        if (!recordScope?.startsWith("project:")) continue;
        const project = recordScope.slice("project:".length).trim();
        if (project && normalizedQuery.includes(project)) namedProjects.add(project);
      }
    }
    const withinBoundary = (record: Pick<PersonalMemoryRecord, "scope" | "date">) => {
      const recordScope = record.scope?.trim().toLocaleLowerCase();
      return matchesRecallScope(record.scope, scope)
        && (namedProjects.size === 0
          || !recordScope?.startsWith("project:")
          || namedProjects.has(recordScope.slice("project:".length).trim()))
        && (!request.from || record.date >= request.from)
        && (!request.to || record.date <= request.to);
    };
    const identityFor = (id: string) => {
      const record = cachedRecordsById.get(id) ?? metadataById.get(id);
      if (!record) {
        throw new PersonalMemoryAccessError("invalid_request", "Personal Memory turn index contains an unavailable record");
      }
      const { supersedes, ...identity } = searchItemIdentity(record);
      // Resolve historical metadata only from this turn's manifest. A current
      // global record cannot expose a project history outside the turn scope.
      const previous = supersedes ? metadataById.get(supersedes) : undefined;
      const historyScope = scope ?? record.scope?.trim().toLocaleLowerCase() ?? "global";
      if (!previous || previous.id === id || forgottenIds.has(previous.id)
        || !withinBoundary(previous) || !matchesRecallScope(previous.scope, historyScope)) {
        return identity;
      }
      return {
        ...identity,
        supersedes,
        ...(record.status === "current" ? {
          supersededRecord: Object.freeze({
            id: previous.id,
            ...(previous.asOf ? { asOf: previous.asOf } : {}),
            readHint: "需要旧原文时按此 id 调用 memory_read，includeHistorical=true；旧内容只作历史参考。"
          })
        } : {})
      };
    };
    const secondaryViewFor = (entry: SecondaryCatalogEntry) =>
      toSecondaryMatchView(entry, secondaryById.get(entry.id));
    const statuses = new Set(request.statuses ?? ["current"]);
    // A project boundary keeps global preferences alongside this project's
    // records. Historical records remain opt-in through explicit statuses.
    const eligible = index.catalog
      .filter((record) => statuses.has(record.status))
      .filter(withinBoundary);
    const ranked = eligible
      .map((record) => {
        const primaryScore = scorePrimaryEntry(record, query, queryTokenSet);
        const secondary = secondaryBest.get(record.id);
        return {
          record,
          primaryScore,
          secondary,
          score: primaryScore + (secondary?.score ?? 0)
        };
      })
      .filter((entry) => browseAll || (queryTokens.length > 0 && entry.score > 0))
      .sort((left, right) =>
        right.score - left.score
        || right.record.date.localeCompare(left.record.date)
        || left.record.id.localeCompare(right.record.id)
      );
    const catalogCandidates = Object.freeze(ranked.map(({ record, score }) => {
      const matches = secondaryMatches.get(record.id);
      return Object.freeze({
        id: record.id,
        kind: record.kind,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: record.summary,
        date: record.date,
        ...identityFor(record.id),
        score,
        ...(matches && matches.length > 0
          ? { secondaryMatches: Object.freeze(matches.map(secondaryViewFor)) }
          : {})
      });
    }));
    const requestedIds = selectCandidateIds
      ? [...selectCandidateIds(catalogCandidates)]
      : catalogCandidates.slice(0, MAX_SEARCH_LIMIT).map((candidate) => candidate.id);
    const rankedById = new Map(ranked.map((entry) => [entry.record.id, entry]));
    const selectedIds = new Set<string>();
    for (const id of requestedIds) {
      if (selectedIds.has(id) || !rankedById.has(id)) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          "Personal Memory turn candidate selection is invalid"
        );
      }
      selectedIds.add(id);
    }
    // A secondary match counts as "decisive" when its parent would NOT have
    // made the candidate set on primary-memory scores alone. Re-run the exact
    // production selector over a primary-only ranking: candidate count is not
    // a valid proxy because the token-budget selector can skip one oversized
    // record and still admit smaller records that follow it.
    const primaryOnlyCandidates = Object.freeze(eligible
      .map((record) => ({
        record,
        primaryScore: scorePrimaryEntry(record, query, queryTokenSet)
      }))
      .filter(({ primaryScore }) => browseAll || (queryTokens.length > 0 && primaryScore > 0))
      .sort((left, right) =>
        right.primaryScore - left.primaryScore
        || right.record.date.localeCompare(left.record.date)
        || left.record.id.localeCompare(right.record.id)
      )
      .map(({ record, primaryScore }) => Object.freeze({
        id: record.id,
        kind: record.kind,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: record.summary,
        date: record.date,
        ...identityFor(record.id),
        score: primaryScore
      })));
    const primaryOnlyRequestedIds = selectCandidateIds
      ? [...selectCandidateIds(primaryOnlyCandidates)]
      : primaryOnlyCandidates.slice(0, MAX_SEARCH_LIMIT).map((candidate) => candidate.id);
    const primaryOnlyCandidateSet = new Set(primaryOnlyRequestedIds);
    const pendingSecondaryHits: Array<Readonly<{ secondaryId: string; parentId: string }>> = [];
    const decisiveSecondaryId = new Map<string, string>();
    for (const id of requestedIds) {
      const entry = rankedById.get(id)!;
      if (!entry.secondary) continue;
      if (!primaryOnlyCandidateSet.has(id)) {
        decisiveSecondaryId.set(id, entry.secondary.entry.id);
        pendingSecondaryHits.push(Object.freeze({ secondaryId: entry.secondary.entry.id, parentId: id }));
      }
    }
    const items = await Promise.all(requestedIds.map(async (id) => {
      const rankedEntry = rankedById.get(id)!;
      const metadata = metadataById.get(id);
      if (!metadata) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          "Personal Memory turn index contains an unavailable record"
        );
      }
      const full = await this.readRecord(metadata);
      const record = rankedEntry.record;
      const matched = secondaryMatches.get(id) ?? [];
      return Object.freeze({
        id: record.id,
        kind: record.kind,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: summarize(full.content),
        date: record.date,
        ...identityFor(id),
        score: rankedEntry.score,
        ...(decisiveSecondaryId.has(id) ? { matchedSecondaryId: decisiveSecondaryId.get(id)! } : {}),
        ...(matched.length > 0 ? { secondaryMatches: Object.freeze(matched.map(secondaryViewFor)) } : {})
      });
    }));
    const total = ranked.length;
    const returned = items.length;
    return Object.freeze({
      revision: manifest.revision,
      total,
      returned,
      remaining: total - returned,
      exhausted: returned === total,
      items: Object.freeze(items),
      pendingSecondaryHits: Object.freeze(pendingSecondaryHits)
    });
  }

  private async loadNoMemoryTurnSnapshot(): Promise<Readonly<PersonalMemoryTurnSnapshot>> {
    const fixed = await this.loadNoMemoryContext();
    return Object.freeze({ ...fixed, scanned: 0, search: null });
  }

  private async loadNoMemoryContext(): Promise<Readonly<{
    revision: number;
    agent: string;
    user: null;
    memory: null;
    injectionKeys: readonly string[];
  }>> {
    return Object.freeze({
      revision: 0,
      agent: "",
      user: null,
      memory: null,
      injectionKeys: Object.freeze([])
    });
  }

  private async loadFixedContextSnapshot(
    manifest: PersonalMemoryManifest,
    memoryMode: "normal" | "no_memory"
  ): Promise<Readonly<{
    revision: number;
    agent: string;
    user: string;
    memory: string | null;
    injectionKeys: readonly string[];
  }>> {
    const fixed = await this.currentFixedContext();
    if (utf8Bytes(fixed.user) > USER_MD_HARD_MAX_BYTES) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "USER.md exceeds the 128 KiB UTF-8 context boundary"
      );
    }
    const agent = fixed.agent;
    const user = fixed.user;
    const memory = memoryMode === "normal" ? fixed.memory : null;
    if (
      !validFixedFileHashes(manifest.fixedFileHashes)
      || manifest.fixedFileHashes.user !== contentHash(user)
      || (
        memory !== null
        && (
          parseGeneratedOverviewRevision(memory) !== manifest.revision
          || memory !== renderOverview(manifest, manifest.records)
        )
      )
    ) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "Personal Memory fixed context changed during snapshot loading"
      );
    }
    return Object.freeze({
      revision: manifest.revision,
      agent,
      user,
      memory,
      injectionKeys: Object.freeze([
        "echoink.user",
        ...(memory === null ? [] : ["echoink.memory.overview"])
      ])
    });
  }

  private async currentFixedContext(): Promise<Readonly<{
    agent: string;
    user: string;
    memory: string;
  }>> {
    if (this.fixedContextCache) return this.fixedContextCache;
    const agent = "";
    const [user, memory] = await Promise.all([
      readUtf8Bounded(this.layout.user, USER_MD_HARD_MAX_BYTES, "USER.md"),
      readBounded(this.layout.memory, MAX_OVERVIEW_CHARS, "MEMORY.md")
    ]);
    this.fixedContextCache = Object.freeze({ agent, user, memory });
    return this.fixedContextCache;
  }

  /** Replace the secondary records snapshot used for Search Index v3 building. */
  setSecondaryRecords(records: readonly SecondaryMemoryRecord[]): void {
    this.secondaryCache = [...records];
  }

  /** Current secondary records snapshot (cognitive system wiring). */
  currentSecondaryRecords(): readonly SecondaryMemoryRecord[] {
    return this.secondaryCache;
  }

  /**
   * Commit one user Memory update in a single transaction: secondary files,
   * state JSONs and USER.md land together with the manifest revision
   * and the derived Search Index v3.
   */
  async applyCognitiveUpdate(
    input: Readonly<CognitiveUpdateInput>
  ): Promise<Readonly<{ revision: number }>> {
    if (input.extraChanges.some((change) => path.posix.normalize(change.relativePath.replaceAll(path.sep, "/")).startsWith("agents/"))) {
      throw new PersonalMemoryAccessError("invalid_request", "Desktop Memory cannot modify legacy Agent files");
    }
    // Reject oversized USER.md output before initialization or mutation-lane
    // entry so no transaction can begin with an invalid new projection.
    const normalizedUserContent = input.userContent === undefined
      ? undefined
      : normalizeUserProfileWrite(input.userContent, "USER.md projection");
    await this.initialize();
    return await this.withMutation(async () =>
      await this.applyCognitiveUpdateInMutation(
        input,
        normalizedUserContent
      )
    );
  }

  /**
   * User-facing association clue edit/delete. The disk refresh, target CAS,
   * read-modify-write and derived-index commit all run in the shared mutation
   * lane so a later writer cannot rebuild state from an older full snapshot.
   */
  async applySecondaryUserMutation(input: Readonly<{
    operation: "edit" | "delete";
    parentId: string;
    secondaryId: string;
    expectedRevision: number;
    edits?: Readonly<{
      title?: string;
      content?: string;
      recallWhen?: string;
      matchTerms?: readonly string[];
      reason?: string;
    }>;
  }>): Promise<Readonly<{ revision: number; record?: SecondaryMemoryRecord }>> {
    const parentId = assertSafeId(input.parentId);
    const secondaryId = assertSafeId(input.secondaryId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new PersonalMemoryAccessError(
        "invalid_request",
        "Secondary fact expectedRevision must be a positive safe integer"
      );
    }
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const all = [...(this.secondaryRefreshProvider
        ? await this.secondaryRefreshProvider()
        : this.secondaryCache)];
      const position = all.findIndex((record) =>
        record.parentId === parentId
          && record.id === secondaryId
          && record.status === "current"
      );
      if (position < 0) {
        throw new PersonalMemoryAccessError(
          "revision_conflict",
          `Secondary fact ${secondaryId} not found; secondary revision conflict`
        );
      }
      const current = all[position];
      if (current.revision !== input.expectedRevision) {
        throw new PersonalMemoryAccessError(
          "revision_conflict",
          `secondary_revision_conflict: expected ${input.expectedRevision}, disk ${current.revision}`
        );
      }

      let record: SecondaryMemoryRecord | undefined;
      let change: Readonly<{ relativePath: string; content?: string }>;
      if (input.operation === "delete") {
        all.splice(position, 1);
        change = Object.freeze({ relativePath: current.file });
      } else {
        const edits = input.edits ?? {};
        const normalized = normalizeAssociationClueFields({
          title: edits.title ?? current.title,
          content: edits.content ?? current.content,
          recallWhen: edits.recallWhen ?? current.recallWhen,
          matchTerms: edits.matchTerms ?? current.matchTerms,
          relation: current.relation,
          reason: edits.reason ?? current.reason,
          supportLevel: current.supportLevel,
          evidence: current.evidence
        });
        record = Object.freeze({
          ...current,
          ...normalized,
          basis: "user_edited_inference" as const,
          revision: current.revision + 1,
          updatedAt: this.now()
        });
        all[position] = record;
        change = Object.freeze({
          relativePath: record.file,
          content: serializeSecondaryRecord(record)
        });
      }

      const result = await this.applyCognitiveUpdateInMutation({
        secondaryRecords: all,
        extraChanges: [change],
        detail: `secondary-user-${input.operation}:${secondaryId}`
      });
      return Object.freeze({ revision: result.revision, ...(record ? { record } : {}) });
    });
  }

  private async applyCognitiveUpdateInMutation(
    input: Readonly<CognitiveUpdateInput>,
    normalizedUserContent: string | undefined = undefined
  ): Promise<Readonly<{ revision: number }>> {
    await this.assertManagedTreeSafe();
    const manifest = await this.readManifest();
    assertExpectedRevision(manifest, input.expectedMemoryRevision);
    await this.assertFixedFilesMatchManifest(manifest);
    if (input.expectedUserProjectionHash !== undefined) {
      const diskUserHash = contentHash(
        await readUtf8Bounded(this.layout.user, USER_MD_HARD_MAX_BYTES, "USER.md")
      );
      if (diskUserHash !== input.expectedUserProjectionHash) {
        throw new PersonalMemoryAccessError(
          "revision_conflict",
          "USER.md projection conflict: disk content changed after projection planning"
        );
      }
    }
    const records = await this.readAllRecords(manifest);
    const targetRevision = manifest.revision + 1;
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    const extra: TransactionChange[] = [...input.extraChanges];
    if (normalizedUserContent !== undefined) {
      next.fixedFileHashes = {
        ...(next.fixedFileHashes ?? { agent: "", user: "" }),
        user: contentHash(normalizedUserContent)
      };
      extra.push({
        relativePath: path.relative(this.layout.root, this.layout.user),
        content: normalizedUserContent
      });
    }
    // 事务成功前不改缓存：用局部快照构造索引与事务内容。
    const changes = await this.stateChanges(next, records, extra, {
      type: "cognitive_update",
      revision: targetRevision,
      at: this.now(),
      detail: cleanOptional(input.detail, "detail", 500) ?? ""
    }, input.secondaryRecords);
    await this.runTransaction("cognitive-update", manifest.revision, targetRevision, changes);
    this.commitSecondaryCache(input.secondaryRecords);
    return Object.freeze({ revision: targetRevision });
  }

  /**
   * Record hit stats on secondary facts that decisively pulled their parent
   * into recall candidates (做梦 PRD §11)：confidence += 0.05（上限 1）、
   * hitCount += 1、更新 lastHitAt、增加二级事实自身 revision；保存必须走
   * Repository 事务，不允许直接裸写文件。
   */
  async recordSecondaryRecallHits(
    hits: readonly Readonly<{ secondaryId: string; parentId: string }>[]
  ): Promise<void> {
    if (hits.length === 0) return;
    await this.initialize();
    await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const now = this.now();
      const cache = [...this.secondaryCache];
      const updatedRecords: SecondaryMemoryRecord[] = [];
      for (const hit of hits) {
        const position = cache.findIndex(
          (record) => record.id === hit.secondaryId
            && record.parentId === hit.parentId
            && record.status === "current"
        );
        if (position < 0) continue;
        const updated = applySecondaryHit(cache[position], now);
        cache[position] = updated;
        updatedRecords.push(updated);
      }
      if (updatedRecords.length === 0) return;
      // 与 applyCognitiveUpdate 相同的单事务提交（不能嵌套 withMutation）。
      const manifest = await this.readManifest();
      await this.assertFixedFilesMatchManifest(manifest);
      const records = await this.readAllRecords(manifest);
      const targetRevision = manifest.revision + 1;
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = now;
      const changes = await this.stateChanges(next, records, updatedRecords.map((record) => ({
        relativePath: record.file,
        content: serializeSecondaryRecord(record)
      })), {
        type: "cognitive_update",
        revision: targetRevision,
        at: now,
        detail: `secondary-recall-hits:${updatedRecords.length}`
      }, cache);
      await this.runTransaction("cognitive-update", manifest.revision, targetRevision, changes);
      this.commitSecondaryCache(cache);
    });
  }

  /** Rebuild the derived Search Index v3 when the secondary snapshot drifted. */
  async ensureSecondaryIndexFresh(): Promise<void> {
    await this.initialize();
    await this.withMutation(async () => {
      const manifest = await this.readManifest();
      const records = await this.readAllRecords(manifest);
      const expected = buildSearchIndexV3(
        manifest.revision,
        records.map((record) => this.catalogInput(record)),
        indexableSecondaryRecords(this.secondaryCache)
      );
      const raw = await readJsonOrNull<Record<string, unknown>>(this.layout.searchIndex);
      if (raw && (raw as { checksum?: unknown }).checksum === expected.checksum) {
        this.searchIndexCache = freezeSearchIndex(expected);
        return;
      }
      await atomicWrite(this.layout.searchIndex, jsonText(expected));
      this.searchIndexCache = freezeSearchIndex(expected);
    });
  }

  private catalogInput(record: PersonalMemoryRecord): BuildIndexCatalogInput {
    return Object.freeze({
      id: record.id,
      kind: record.kind,
      status: record.status,
      title: record.title,
      recallWhen: record.recallWhen,
      date: record.date,
      basis: record.basis,
      sourceSummary: summarizeSource(record.source),
      summary: summarize(record.content),
      ...(record.scope ? { scope: record.scope } : {}),
      content: record.content
    });
  }

  /** Attach/replace the secondary lifecycle handler after construction. */
  setSecondaryLifecycleHandler(handler: (input: Readonly<{
    operation: "supersede" | "forget" | "restore" | "close";
    parentId: string;
  }>) => Promise<Readonly<{
    records: readonly SecondaryMemoryRecord[];
    changedFiles: readonly Readonly<{ relativePath: string; content: string }>[];
  }>>): void {
    this.secondaryLifecycleHook = handler;
  }

  /** Read every secondary record from disk while holding the Repository lane. */
  setSecondaryRefreshProvider(
    provider: () => Promise<readonly SecondaryMemoryRecord[]>
  ): void {
    this.secondaryRefreshProvider = provider;
  }

  /**
   * Fired synchronously AFTER a committed transaction changed secondary
   * records, carrying the committed records（双缓存一致性：调用方用它同步
   * setCache，不做 fire-and-forget 异步刷新）。
   */
  setSecondaryChangedHook(hook: (records: readonly SecondaryMemoryRecord[]) => void): void {
    this.secondaryChangedHook = hook;
  }

  /** Attach/replace the memory-committed hook (dream pending queue). */
  setMemoryCommittedHook(hook: (event: Readonly<{
    operation: "create" | "supersede" | "restore";
    recordId: string;
    revision: number;
  }>) => void): void {
    this.onMemoryCommittedHook = hook;
  }

  /**
   * 事务成功后同步两份缓存（Repository.secondaryCache 与 SecondaryMemoryStore
   * 经由 hook）；事务失败时任何缓存都不得改变。
   */
  private commitSecondaryCache(records: readonly SecondaryMemoryRecord[]): void {
    this.secondaryCache = [...records];
    try {
      this.secondaryChangedHook?.(Object.freeze([...records]));
    } catch { /* never break the writer */ }
  }

  private async applySecondaryLifecycle(
    operation: "supersede" | "forget" | "restore" | "close",
    parentId: string
  ): Promise<Readonly<{
    files: readonly Readonly<{ relativePath: string; content: string }>[];
    records: readonly SecondaryMemoryRecord[];
  }>> {
    if (!this.secondaryLifecycleHook) {
      return Object.freeze({ files: Object.freeze([]), records: this.secondaryCache });
    }
    const result = await this.secondaryLifecycleHook({ operation, parentId });
    // 事务提交前不得改缓存；records 由调用方在 runTransaction 成功后提交。
    return Object.freeze({ files: result.changedFiles, records: result.records });
  }

  /**
   * 一级 Memory 生命周期变化与 USER.md 受控投影同事务对账。
   * 这里只撤销已失效来源；新增来源仍由 profile_update 或后续 Dream 提炼，
   * 避免在 Repository 中引入第二套语义分类器。
   */
  private async reconcileControlledProjectionSources(
    records: readonly PersonalMemoryRecord[],
    now: number,
    options: Readonly<{
      includeUser?: boolean;
      invalidatedProductRunIds?: ReadonlySet<string>;
      replacement?: Readonly<{
        previousMemoryId: string;
        replacementMemoryId: string;
        previousMemoryRevision: number;
        replacementText: string;
      }>;
    }> = {}
  ): Promise<ProjectionReconciliation> {
    const validMemoryIds = new Set(records
      .filter((record) => record.status === "current")
      .map((record) => record.id));
    const invalidatedProductRunIds = new Set([
      ...invalidatedMemoryProductRunIds(records),
      ...(options.invalidatedProductRunIds ?? [])
    ]);
    const fixed = await this.currentFixedContext();
    const changes: TransactionChange[] = [];
    let userHash: string | undefined;

    const profileStore = new UserProfileStateStore(this.layout.root);
    const previousProfile = options.includeUser === false
      ? null
      : await profileStore.read();
    if (previousProfile) {
      if (
        previousProfile.lastProjectedUserHash
        && previousProfile.lastProjectedUserHash !== contentHash(fixed.user)
      ) {
        throw new PersonalMemoryAccessError(
          "revision_conflict",
          "USER.md projection conflict: disk content differs from profile state"
        );
      }
      const rebindsExplicitProfile = Boolean(options.replacement)
        && previousProfile.items.some((item) =>
          item.status === "current"
          && item.basis !== "observed_memory"
          && item.sourceMemoryIds.includes(options.replacement!.previousMemoryId)
        );
      const replacementText = rebindsExplicitProfile
        ? cleanRequired(
            options.replacement!.replacementText,
            "replacement USER profile text",
            USER_PROFILE_ITEM_HARD_MAX_CHARS
          )
        : options.replacement?.replacementText ?? "";
      const profileBase = options.replacement
        ? rebindProfileSource(previousProfile, {
            previousMemoryId: options.replacement.previousMemoryId,
            replacementMemoryId: options.replacement.replacementMemoryId,
            previousMemoryRevision: options.replacement.previousMemoryRevision,
            replacementText,
            now
          })
        : previousProfile;
      const validProfileSourceIds = new Set(validMemoryIds);
      for (const item of profileBase.items) {
        for (const sourceId of item.sourceMemoryIds) {
          const productRunId = productRunIdFromExperienceProfileSourceId(sourceId);
          if (productRunId && !invalidatedProductRunIds.has(productRunId)) {
            validProfileSourceIds.add(sourceId);
          }
        }
      }
      let nextProfile = reconcileProfileSources(profileBase, validProfileSourceIds, now);
      if (nextProfile !== previousProfile) {
        const projectedUser = normalizeUserProfileWrite(
          renderUserMarkdown(nextProfile),
          "USER.md projection"
        );
        nextProfile = Object.freeze({
          ...nextProfile,
          lastProjectedUserHash: contentHash(projectedUser)
        });
        changes.push({
          relativePath: path.relative(this.layout.root, this.layout.userProfileState),
          content: userProfileStateJson(nextProfile)
        });
        if (projectedUser !== fixed.user) {
          userHash = contentHash(projectedUser);
          changes.push({
            relativePath: path.relative(this.layout.root, this.layout.user),
            content: projectedUser
          });
        }
      }
    }

    return Object.freeze({
      changes: Object.freeze(changes),
      ...(userHash ? { userHash } : {})
    });
  }

  private notifyMemoryCommitted(
    operation: "create" | "supersede" | "restore",
    recordId: string,
    revision: number
  ): void {
    try {
      this.onMemoryCommittedHook?.({ operation, recordId, revision });
    } catch {
      // Dream queueing must never break the write result.
    }
  }

  async read(
    id: string,
    runtime: Readonly<PersonalMemoryRuntimeContext>,
    options: Readonly<{ includeHistorical?: boolean }> = {}
  ): Promise<Readonly<{ revision: number; record: PersonalMemoryRecord }>> {
    this.assertRuntime(runtime);
    const safeId = assertSafeId(id);
    await this.initialize();
    const manifest = await this.readManifest();
    const metadata = manifest.records.find((record) => record.id === safeId);
    if (!metadata || (!options.includeHistorical && metadata.status !== "current")) {
      throw new PersonalMemoryAccessError("not_found", `Memory ${safeId} is unavailable`);
    }
    return Object.freeze({
      revision: manifest.revision,
      record: await this.readRecord(metadata)
    });
  }

  async inspect(): Promise<Readonly<{
    revision: number;
    records: readonly PersonalMemoryRecord[];
    tombstones: readonly PersonalMemoryTombstone[];
    backups: readonly string[];
  }>> {
    await this.initialize();
    const manifest = await this.readManifest();
    return Object.freeze({
      revision: manifest.revision,
      records: Object.freeze(await this.readAllRecords(manifest)),
      tombstones: Object.freeze(manifest.tombstones.map((item) => Object.freeze({ ...item }))),
      backups: Object.freeze(await listFilesRecursively(this.layout.backups))
    });
  }

  /** Dream reads only the user projection, never legacy Agent Self. */
  async inspectCognitiveFixedFiles(): Promise<Readonly<{
    user: string;
    userHash: string;
    userBytes: number;
  }>> {
    await this.initialize();
    return await this.withMutation(async () => {
      const { user } = await this.currentFixedContext();
      const userHash = contentHash(user);
      return Object.freeze({
        user,
        userHash,
        userBytes: utf8Bytes(user)
      });
    });
  }

  /** A user expanding an injected source reads only that record, without Agent/Provider admission. */
  async readUserControlSource(id: string, expectedRevision?: number): Promise<Readonly<{
    status: "available" | "changed" | "missing";
    content?: string;
  }>> {
    const safeId = assertSafeId(id);
    await this.initialize();
    const manifest = await this.readManifest();
    const metadata = manifest.records.find(record => record.id === safeId);
    if (!metadata) return { status: "missing" };
    if (metadata.status === "superseded") return { status: "changed" };
    if (metadata.status !== "current") return { status: "missing" };
    if (expectedRevision !== undefined && metadata.revision !== expectedRevision) return { status: "changed" };
    const record = await this.readRecord(metadata);
    if (expectedRevision !== undefined && record.revision !== expectedRevision) return { status: "changed" };
    return { status: "available", content: record.content };
  }

  async readUserControlState(): Promise<Readonly<{
    revision: number;
    agent: string;
    user: string;
    memory: string;
    records: readonly PersonalMemoryRecord[];
    forgottenIds: readonly string[];
  }>> {
    await this.initialize();
    const [manifest, fixed] = await Promise.all([
      this.readManifest(),
      this.currentFixedContext()
    ]);
    if (utf8Bytes(fixed.user) > USER_MD_HARD_MAX_BYTES) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "USER.md exceeds the 128 KiB UTF-8 control boundary"
      );
    }
    const activeRecordIds = new Set(manifest.records.map((item) => item.id));
    return Object.freeze({
      revision: manifest.revision,
      agent: fixed.agent,
      user: fixed.user,
      memory: fixed.memory,
      records: Object.freeze(await this.readAllRecords(manifest)),
      forgottenIds: Object.freeze([...new Set(manifest.tombstones
        .map((item) => item.recordId)
        .filter((id) => !activeRecordIds.has(id)))])
    });
  }

  async readUserProfileControlSnapshot(): Promise<UserProfileControlSnapshot> {
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedPathsSafe([
        this.layout.manifest, this.layout.user, this.layout.userProfileState
      ]);
      const manifest = await this.readManifestFromDisk();
      const diskUser = await readUtf8Bounded(this.layout.user, USER_MD_HARD_MAX_BYTES, "USER.md");
      if (!validFixedFileHashes(manifest.fixedFileHashes)
        || contentHash(diskUser) !== manifest.fixedFileHashes.user) {
        throw new PersonalMemoryAccessError("revision_conflict", "USER control snapshot does not match the committed manifest");
      }
      const profile = await this.readManagedUserProfile(this.now(), diskUser);
      const records = await this.readAllRecordsFromDisk(manifest);
      const validSources = new Set(records.filter((record) => record.status === "current").map((record) => record.id));
      const invalidatedRuns = invalidatedMemoryProductRunIds(records);
      for (const item of profile.items) {
        for (const sourceId of item.sourceMemoryIds) {
          const runId = productRunIdFromExperienceProfileSourceId(sourceId);
          if (runId && !invalidatedRuns.has(runId)) validSources.add(sourceId);
        }
      }
      const reconciled = reconcileProfileSources(profile, validSources, this.now());
      return Object.freeze({
        revision: manifest.revision,
        items: Object.freeze(projectedProfileItems(reconciled).map((item) => Object.freeze({
          ...item, sourceMemoryIds: Object.freeze([...item.sourceMemoryIds])
        })))
      });
    });
  }

  /** Local user management deliberately has no runtime/Provider prerequisite. */
  async saveUserProfileFromUserControl(
    input: UserProfileControlSaveRequest
  ): Promise<UserProfileControlMutationResult> {
    assertUserProfileControlRevision(input.expectedRevision);
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      await this.refreshPrimaryCachesBeforeWrite();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, input.expectedRevision);
      await this.assertFixedFilesMatchManifest(manifest);
      const result = await this.updateUserProfileWithSource(
        manifest,
        await this.readAllRecords(manifest),
        { ...input, operation: "profile_update", basis: "explicit", contentOrigin: "user_edit" },
        "ui://user-profile-control",
        Object.freeze({}),
        true
      );
      return Object.freeze({ revision: result.revision });
    });
  }

  async deleteUserProfileFromUserControl(
    input: UserProfileControlDeleteRequest
  ): Promise<UserProfileControlMutationResult> {
    assertUserProfileControlRevision(input.expectedRevision);
    if (!profileSlotDefinition(input.profileKey)) {
      throw new PersonalMemoryAccessError("invalid_request", "profileKey must use the closed user profile taxonomy");
    }
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      await this.refreshPrimaryCachesBeforeWrite();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, input.expectedRevision);
      await this.assertFixedFilesMatchManifest(manifest);
      const now = this.now();
      const previous = await this.readManagedUserProfile(now);
      let profile: UserProfileState = Object.freeze({
        ...previous,
        revision: previous.revision + 1,
        items: Object.freeze(previous.items.filter((item) => item.profileKey !== input.profileKey)),
        deletionBarriers: Object.freeze([
          ...(previous.deletionBarriers ?? []).filter((entry) => entry.profileKey !== input.profileKey),
          Object.freeze({
            profileKey: input.profileKey,
            memoryRevisionCutoff: manifest.revision,
            experienceOccurredAtCutoff: now
          })
        ]),
        updatedAt: now
      });
      const user = normalizeUserProfileWrite(renderUserMarkdown(profile), "USER.md projection");
      profile = Object.freeze({ ...profile, lastProjectedUserHash: contentHash(user) });
      const next = cloneManifest(manifest);
      next.revision = manifest.revision + 1;
      next.updatedAt = now;
      next.fixedFileHashes = { ...manifest.fixedFileHashes!, user: contentHash(user) };
      const changes = await this.stateChanges(next, await this.readAllRecords(manifest), [
        { relativePath: path.relative(this.layout.root, this.layout.userProfileState), content: userProfileStateJson(profile) },
        { relativePath: path.relative(this.layout.root, this.layout.user), content: user }
      ], {
        type: "profile_updated", revision: next.revision, at: now,
        profile: "user", profileKey: input.profileKey, operation: "delete",
        source: "ui://user-profile-control"
      });
      await this.runTransaction("profile-delete", manifest.revision, next.revision, changes);
      return Object.freeze({ revision: next.revision });
    });
  }

  async updateIdentityFile(
    profile: "user",
    contentValue: string,
    expectedRevision: number
  ): Promise<Readonly<{ revision: number; profile: "user" }>> {
    if (profile !== "user") throw new PersonalMemoryAccessError("invalid_request", "Desktop Memory only manages the user profile");
    const normalizedContent = normalizeUserProfileWrite(contentValue, "user profile");
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, expectedRevision);
      await this.assertFixedFilesMatchManifest(manifest);
      const records = await this.readAllRecords(manifest);
      const targetRevision = manifest.revision + 1;
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = this.now();
      next.fixedFileHashes = {
        ...manifest.fixedFileHashes!,
        [profile]: contentHash(normalizedContent)
      };
      const changes = await this.stateChanges(next, records, [{
        relativePath: path.relative(
          this.layout.root,
          this.layout.user
        ),
        content: normalizedContent
      }], {
        type: "identity_file_updated",
        revision: targetRevision,
        at: this.now(),
        profile,
        source: "ui://personal-memory-control"
      });
      await this.runTransaction(`identity-${profile}`, manifest.revision, targetRevision, changes);
      return Object.freeze({ revision: targetRevision, profile });
    });
  }

  async forgetFromUserControl(
    recordId: string,
    reason: string,
    expectedRevision: number
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      await this.refreshPrimaryCachesBeforeWrite();
      await this.reconcilePrimaryTargetsBeforeMutation([recordId]);
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, expectedRevision);
      const records = await this.readAllRecords(manifest);
      return await this.forgetRecordWithSource(
        manifest,
        records,
        recordId,
        reason,
        "ui://personal-memory-control"
      );
    });
  }

  async supersedeFromUserCorrection(input: Readonly<{
    targetId: string;
    title: string;
    content: string;
    recallWhen: string;
    reason: string;
    expectedRevision: number;
  }>): Promise<Readonly<PersonalMemoryWriteResult>> {
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      await this.refreshPrimaryCachesBeforeWrite();
      await this.reconcilePrimaryTargetsBeforeMutation([input.targetId]);
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, input.expectedRevision);
      const records = await this.readAllRecords(manifest);
      const targetId = assertSafeId(input.targetId);
      const previous = records.find((record) =>
        record.id === targetId && record.status === "current"
      );
      if (!previous) {
        throw new PersonalMemoryAccessError(
          "not_found",
          `Current Memory ${targetId} does not exist`
        );
      }
      return await this.supersedeRecordWithSource(
        manifest,
        records,
        {
          operation: "supersede",
          targetId,
          title: input.title,
          content: input.content,
          recallWhen: input.recallWhen,
          basis: "explicit",
          contentOrigin: "user_edit",
          reason: input.reason,
          expectedRevision: input.expectedRevision,
          ...(previous.scope ? { scope: previous.scope } : {}),
          ...(previous.asOf ? { asOf: previous.asOf } : {}),
          ...(previous.due ? { due: previous.due } : {}),
          ...(previous.remindAt ? { remindAt: previous.remindAt } : {})
        },
        "ui://personal-memory-correction",
        Object.freeze({}),
        true
      );
    });
  }

  async exportMemory(): Promise<Readonly<{ path: string; revision: number }>> {
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      await this.refreshPrimaryCachesBeforeWrite();
      await this.refreshPrimarySourceDirectories();
      const manifest = await this.readManifest();
      const records = await this.readAllRecords(manifest);
      const timestamp = new Date(this.now()).toISOString().replaceAll(/[:.]/gu, "-");
      const relativePath = path.posix.join("shared-user", ".runtime", "backups", "exports", `memory-export-${timestamp}.md`);
      const targetRevision = manifest.revision + 1;
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = this.now();
      const exportText = renderExport(records, targetRevision);
      const changes = await this.stateChanges(next, records, [{ relativePath, content: exportText }], {
        type: "exported",
        revision: targetRevision,
        at: this.now(),
        detail: relativePath
      });
      await this.runTransaction("export", manifest.revision, targetRevision, changes);
      return Object.freeze({ path: this.absoluteFromRelative(relativePath), revision: targetRevision });
    });
  }

  async restoreForgotten(
    recordId: string,
    expectedRevision?: number
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const safeId = assertSafeId(recordId);
    await this.initialize();
    return await this.withMutation(async () => {
      await this.assertManagedTreeSafe();
      await this.refreshPrimaryCachesBeforeWrite();
      await this.refreshPrimarySourceDirectories();
      const manifest = await this.readManifest();
      assertExpectedRevision(manifest, expectedRevision);
      if (manifest.records.some((record) => record.id === safeId)) {
        throw new PersonalMemoryAccessError("revision_conflict", `Memory ${safeId} already exists`);
      }
      const tombstone = [...manifest.tombstones].reverse().find((item) => item.recordId === safeId);
      if (!tombstone) throw new PersonalMemoryAccessError("not_found", `Forgotten Memory ${safeId} has no backup`);
      const backupPath = this.absoluteFromRelative(tombstone.backupFile);
      const backupText = await readFile(backupPath, "utf8");
      const temporary = parseRecord(backupText, tombstone.backupFile);
      const targetRevision = manifest.revision + 1;
      const restored: PersonalMemoryRecord = Object.freeze({
        ...temporary,
        revision: targetRevision,
        file: recordRelativePath(temporary.kind, temporary.id)
      });
      const records = await this.readAllRecords(manifest);
      const next = cloneManifest(manifest);
      next.revision = targetRevision;
      next.updatedAt = this.now();
      next.records.push(recordMetadata(restored));
      next.records.sort((a, b) => a.id.localeCompare(b.id));
      next.tombstones = next.tombstones.filter((item) =>
        item.recordId !== tombstone.recordId || item.backupFile !== tombstone.backupFile
      );
      const allRecords = [...records, restored];
      const lifecycle = await this.applySecondaryLifecycle("restore", safeId);
      const changes = await this.stateChanges(next, allRecords, [{
        relativePath: restored.file,
        content: serializeRecord(restored)
      }, ...lifecycle.files], {
        type: "forget_restored",
        revision: targetRevision,
        at: this.now(),
        recordId: safeId,
        backupFile: tombstone.backupFile
      }, lifecycle.records);
      await this.runTransaction("restore-forgotten", manifest.revision, targetRevision, changes);
      this.commitSecondaryCache(lifecycle.records);
      this.notifyMemoryCommitted("restore", restored.id, targetRevision);
      return Object.freeze({ revision: targetRevision, record: restored });
    });
  }

  async listManagedFiles(): Promise<readonly string[]> {
    await this.initialize();
    await this.assertManagedTreeSafe();
    const files = [
      ...(await listFilesRecursively(this.layout.sharedUser))
    ];
    return Object.freeze(files
      .map((file) => path.relative(this.vaultPath, file))
      .sort(compareText));
  }

  private async createRecord(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "create" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    validateWriteContent(request.kind, request.basis, request.contentOrigin, runtime.explicitlyAuthorized === true);
    const targetRevision = manifest.revision + 1;
    const record = this.newRecord({ ...request, targetRevision, source: runtimeSource(runtime) });
    if (manifest.records.some((item) => item.id === record.id)) {
      throw new PersonalMemoryAccessError("revision_conflict", `Memory id ${record.id} already exists`);
    }
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records.push(recordMetadata(record));
    const allRecords = [...records, record];
    const changes = await this.stateChanges(next, allRecords, [{ relativePath: record.file, content: serializeRecord(record) }], {
      type: "created",
      revision: targetRevision,
      at: this.now(),
      recordId: record.id,
      source: record.source,
      ...runtimeAuditLink(runtime)
    });
    await this.runTransaction("create", manifest.revision, targetRevision, changes);
    this.notifyMemoryCommitted("create", record.id, targetRevision);
    return Object.freeze({ revision: targetRevision, record });
  }

  private async supersedeRecord(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "supersede" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    return await this.supersedeRecordWithSource(
      manifest,
      records,
      request,
      runtimeSource(runtime),
      runtimeAuditLink(runtime),
      runtime.explicitlyAuthorized === true
    );
  }

  private async supersedeRecordWithSource(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "supersede" }>,
    source: string,
    auditLink: Readonly<{ toolCallId?: string }>,
    explicitlyAuthorized: boolean
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const targetId = assertSafeId(request.targetId);
    const previous = records.find((record) => record.id === targetId && record.status === "current");
    if (!previous) throw new PersonalMemoryAccessError("not_found", `Current Memory ${targetId} does not exist`);
    await this.assertFixedFilesMatchManifest(manifest);
    validateWriteContent(previous.kind, request.basis, request.contentOrigin, explicitlyAuthorized);
    const targetRevision = manifest.revision + 1;
    const superseded: PersonalMemoryRecord = Object.freeze({
      ...previous,
      status: "superseded",
      reason: cleanRequired(request.reason, "reason", 2_000),
      revision: targetRevision
    });
    const replacement = this.newRecord({
      ...request,
      kind: previous.kind,
      targetRevision,
      source,
      supersedes: previous.id
    });
    const allRecords = records.map((record) => record.id === previous.id ? superseded : record).concat(replacement);
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records = allRecords.map(recordMetadata);
    const lifecycle = await this.applySecondaryLifecycle("supersede", previous.id);
    const projection = await this.reconcileControlledProjectionSources(
      allRecords,
      this.now(),
      {
        invalidatedProductRunIds: new Set(
          [productRunIdFromMemorySource(previous.source)]
            .filter((value): value is string => value !== null)
        ),
        replacement: {
          previousMemoryId: previous.id,
          replacementMemoryId: replacement.id,
          previousMemoryRevision: previous.revision,
          replacementText: replacement.content
        }
      }
    );
    if (projection.userHash) {
      next.fixedFileHashes = {
        ...manifest.fixedFileHashes!,
        ...(projection.userHash ? { user: projection.userHash } : {})
      };
    }
    const changes = await this.stateChanges(next, allRecords, [
      { relativePath: superseded.file, content: serializeRecord(superseded) },
      { relativePath: replacement.file, content: serializeRecord(replacement) },
      ...lifecycle.files,
      ...projection.changes
    ], {
      type: "superseded",
      revision: targetRevision,
      at: this.now(),
      recordId: replacement.id,
      targetId: previous.id,
      source: replacement.source,
      ...auditLink
    }, lifecycle.records);
    await this.runTransaction("supersede", manifest.revision, targetRevision, changes);
    this.commitSecondaryCache(lifecycle.records);
    this.notifyMemoryCommitted("supersede", replacement.id, targetRevision);
    return Object.freeze({ revision: targetRevision, record: replacement });
  }

  private async closeRecord(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "close" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const targetId = assertSafeId(request.targetId);
    const previous = records.find((record) => record.id === targetId && record.status === "current");
    if (!previous) throw new PersonalMemoryAccessError("not_found", `Current Memory ${targetId} does not exist`);
    await this.assertFixedFilesMatchManifest(manifest);
    const targetRevision = manifest.revision + 1;
    const closed: PersonalMemoryRecord = Object.freeze({
      ...previous,
      status: "closed",
      reason: cleanRequired(request.reason, "reason", 2_000),
      revision: targetRevision
    });
    const allRecords = records.map((record) => record.id === targetId ? closed : record);
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records = allRecords.map(recordMetadata);
    const lifecycle = await this.applySecondaryLifecycle("close", targetId);
    const projection = await this.reconcileControlledProjectionSources(
      allRecords,
      this.now(),
      {
        invalidatedProductRunIds: new Set(
          [productRunIdFromMemorySource(previous.source)]
            .filter((value): value is string => value !== null)
        )
      }
    );
    if (projection.userHash) {
      next.fixedFileHashes = {
        ...manifest.fixedFileHashes!,
        ...(projection.userHash ? { user: projection.userHash } : {})
      };
    }
    const changes = await this.stateChanges(next, allRecords, [
      { relativePath: closed.file, content: serializeRecord(closed) },
      ...lifecycle.files,
      ...projection.changes
    ], {
      type: "closed",
      revision: targetRevision,
      at: this.now(),
      recordId: targetId,
      source: runtimeSource(runtime),
      ...runtimeAuditLink(runtime)
    }, lifecycle.records);
    await this.runTransaction("close", manifest.revision, targetRevision, changes);
    this.commitSecondaryCache(lifecycle.records);
    return Object.freeze({ revision: targetRevision, record: closed });
  }

  private async updateUserProfile(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "profile_update" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    return await this.updateUserProfileWithSource(
      manifest, records, request, runtimeSource(runtime), runtimeAuditLink(runtime),
      runtime.explicitlyAuthorized === true
    );
  }

  private async readManagedUserProfile(now: number, userContent?: string): Promise<UserProfileState> {
    const diskUser = userContent ?? await readUtf8Bounded(this.layout.user, USER_MD_HARD_MAX_BYTES, "USER.md");
    const diskUserHash = contentHash(diskUser);
    let profile = (await new UserProfileStateStore(this.layout.root).read()) ?? emptyUserProfileState(now);
    if (profile.revision === 0 && profile.legacyUserMigration === null) {
      if (diskUserHash !== contentHash(defaultUserProfile())) {
        throw new PersonalMemoryAccessError("revision_conflict", "USER.md projection conflict: custom content has no managed projection baseline");
      }
      profile = Object.freeze({
        ...profile, revision: 1, legacyUserMigration: "done" as const,
        lastProjectedUserHash: diskUserHash, updatedAt: now
      });
    } else if (profile.lastProjectedUserHash !== diskUserHash) {
      throw new PersonalMemoryAccessError("revision_conflict", "USER.md projection conflict: disk content differs from the last managed projection");
    }
    return profile;
  }

  private async updateUserProfileWithSource(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "profile_update" }>,
    source: string,
    auditLink: Readonly<{ toolCallId?: string }>,
    explicitlyAuthorized: boolean
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const origin = request.contentOrigin ?? "confirmed_change";
    if (!["user_edit", "user_statement", "confirmed_change"].includes(origin)) {
      throw new PersonalMemoryAccessError("invalid_request", "USER.md requires an explicit stable user update");
    }
    validateWriteContent("fact", "explicit", origin, explicitlyAuthorized);
    const slot = profileSlotDefinition(request.profileKey);
    if (!slot) {
      throw new PersonalMemoryAccessError("invalid_request", "profileKey must use the closed user profile taxonomy");
    }
    const text = cleanRequired(request.text, "profile text", USER_PROFILE_ITEM_HARD_MAX_CHARS);
    const now = this.now();
    const previousProfile = await this.readManagedUserProfile(now);
    const currentExplicit = previousProfile.items.find((item) =>
      item.profileKey === slot.profileKey
      && item.basis === "explicit_memory"
      && item.status === "current"
    );
    const previousSource = currentExplicit?.sourceMemoryIds
      .map((sourceId) => records.find((record) =>
        record.id === sourceId && record.status === "current"
      ))
      .find((record): record is PersonalMemoryRecord => Boolean(record));
    const requestedTarget = request.targetId
      ? records.find((record) =>
          record.id === assertSafeId(request.targetId) && record.status === "current"
        )
      : undefined;
    if (request.targetId && !requestedTarget) {
      throw new PersonalMemoryAccessError(
        "not_found",
        `Current Memory ${request.targetId} does not exist`
      );
    }
    if (previousSource && requestedTarget && previousSource.id !== requestedTarget.id) {
      throw new PersonalMemoryAccessError(
        "invalid_request",
        "profile_update target conflicts with the current source for this profileKey"
      );
    }
    if (
      currentExplicit
      && previousSource
      && !previousProfile.deletionBarriers?.some((entry) => entry.profileKey === slot.profileKey)
      && normalizeTextForDedupe(currentExplicit.text) === normalizeTextForDedupe(text)
      && normalizeTextForDedupe(previousSource.content) === normalizeTextForDedupe(text)
    ) {
      return Object.freeze({
        revision: manifest.revision,
        profile: "user" as const,
        record: previousSource,
        status: "idempotent" as const
      });
    }
    const exactGenericSource = records.find((record) =>
      record.status === "current"
      && record.kind === "fact"
      && record.basis === "explicit"
      && normalizeTextForDedupe(record.content) === normalizeTextForDedupe(text)
    );
    const target = previousSource ?? requestedTarget ?? exactGenericSource;
    const targetRevision = manifest.revision + 1;
    const reusesExisting = Boolean(target)
      && normalizeTextForDedupe(target!.content) === normalizeTextForDedupe(text);
    const record = reusesExisting
      ? target!
      : this.newRecord({
          kind: "fact",
          title: `用户画像：${slot.labelZh}`,
          content: text,
          recallWhen: `需要了解用户的${slot.labelZh}时`,
          basis: "explicit",
          contentOrigin: origin,
          targetRevision,
          source,
          reason: "profile_update",
          ...(target ? { supersedes: target.id } : {})
        });
    if (!reusesExisting && manifest.records.some((item) => item.id === record.id)) {
      throw new PersonalMemoryAccessError("revision_conflict", `Memory id ${record.id} already exists`);
    }
    const supersededSource = target && target.id !== record.id
      ? Object.freeze({
          ...target,
          status: "superseded" as const,
          reason: "profile_update",
          revision: targetRevision
        })
      : null;
    const profileBase = supersededSource
      ? rebindProfileSource(previousProfile, {
          previousMemoryId: supersededSource.id,
          replacementMemoryId: record.id,
          previousMemoryRevision: target!.revision,
          replacementText: text,
          now
        })
      : previousProfile;
    const explicitProfileBase = Object.freeze({
      ...profileBase,
      deletionBarriers: Object.freeze((profileBase.deletionBarriers ?? [])
        .filter((entry) => entry.profileKey !== slot.profileKey))
    });
    let nextProfile = applyDreamProfileUpdate(explicitProfileBase, {
      items: [{
        section: slot.section,
        profileKey: slot.profileKey,
        text,
        basis: "explicit_memory",
        sourceMemoryId: record.id,
        sourceEvidence: { kind: "memory", revision: record.revision }
      }],
      processedSources: [{ memoryId: record.id, memoryRevision: record.revision }],
      now,
      legacyUserMigration: "done"
    });
    const projectedUser = normalizeUserProfileWrite(
      renderUserMarkdown(nextProfile),
      "USER.md projection"
    );
    nextProfile = Object.freeze({
      ...nextProfile,
      lastProjectedUserHash: contentHash(projectedUser)
    });
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = now;
    const allRecords = records
      .map((candidate) => candidate.id === supersededSource?.id ? supersededSource : candidate)
      .concat(reusesExisting ? [] : [record]);
    next.records = allRecords.map(recordMetadata);
    const lifecycle = supersededSource
      ? await this.applySecondaryLifecycle("supersede", supersededSource.id)
      : Object.freeze({
          files: Object.freeze([]),
          records: Object.freeze([...this.secondaryCache])
        });
    const projection = await this.reconcileControlledProjectionSources(
      allRecords,
      now,
      {
        includeUser: false,
        ...(supersededSource
          ? {
              invalidatedProductRunIds: new Set(
                [productRunIdFromMemorySource(supersededSource.source)]
                  .filter((value): value is string => value !== null)
              ),
              replacement: {
                previousMemoryId: supersededSource.id,
                replacementMemoryId: record.id,
                previousMemoryRevision: target!.revision,
                replacementText: text
              }
            }
          : {})
      }
    );
    next.fixedFileHashes = {
      agent: manifest.fixedFileHashes!.agent,
      user: contentHash(projectedUser)
    };
    const changes = await this.stateChanges(next, allRecords, [
      ...(supersededSource
        ? [{ relativePath: supersededSource.file, content: serializeRecord(supersededSource) }]
        : []),
      ...(!reusesExisting
        ? [{ relativePath: record.file, content: serializeRecord(record) }]
        : []),
      ...lifecycle.files,
      ...projection.changes,
      {
        relativePath: path.relative(this.layout.root, this.layout.userProfileState),
        content: userProfileStateJson(nextProfile)
      },
      {
        relativePath: path.relative(this.layout.root, this.layout.user),
        content: projectedUser
      }
    ], {
      type: "profile_updated",
      revision: targetRevision,
      at: now,
      profile: "user",
      recordId: record.id,
      ...(target ? { targetId: target.id } : {}),
      source,
      ...auditLink
    }, lifecycle.records);
    await this.runTransaction("profile-update", manifest.revision, targetRevision, changes);
    this.commitSecondaryCache(lifecycle.records);
    if (!reusesExisting) {
      this.notifyMemoryCommitted(
        supersededSource ? "supersede" : "create",
        record.id,
        targetRevision
      );
    }
    return Object.freeze({ revision: targetRevision, profile: "user", record });
  }

  private async forgetRecord(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    request: Extract<PersonalMemoryWriteRequest, { operation: "forget" }>,
    runtime: Readonly<PersonalMemoryRuntimeContext>
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    if (!request.explicitForget || runtime.explicitlyAuthorized !== true) {
      throw new PersonalMemoryAccessError("invalid_request", "Forget requires explicit user authorization");
    }
    return await this.forgetRecordWithSource(
      manifest,
      records,
      request.targetId,
      request.reason,
      runtimeSource(runtime),
      runtime.toolCallId
    );
  }

  private async forgetRecordWithSource(
    manifest: PersonalMemoryManifest,
    records: PersonalMemoryRecord[],
    recordId: string,
    reason: string,
    source: string,
    toolCallId?: string
  ): Promise<Readonly<PersonalMemoryWriteResult>> {
    const targetId = assertSafeId(recordId);
    const target = records.find((record) => record.id === targetId);
    if (!target) throw new PersonalMemoryAccessError("not_found", `Memory ${targetId} does not exist`);
    await this.assertFixedFilesMatchManifest(manifest);
    const targetRevision = manifest.revision + 1;
    const backupFile = path.posix.join(
      "shared-user", ".runtime", "backups", "forgets",
      `${target.id}-${this.now()}.md`
    );
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records = next.records.filter((record) => record.id !== targetId);
    next.tombstones.push({
      recordId: target.id,
      forgottenAt: this.now(),
      reason: cleanRequired(reason, "reason", 2_000),
      backupFile,
      source
    });
    const remaining = records.filter((record) => record.id !== targetId);
    const lifecycle = await this.applySecondaryLifecycle("forget", targetId);
    const projection = await this.reconcileControlledProjectionSources(
      remaining,
      this.now(),
      {
        invalidatedProductRunIds: new Set(
          [productRunIdFromMemorySource(target.source)]
            .filter((value): value is string => value !== null)
        )
      }
    );
    if (projection.userHash) {
      next.fixedFileHashes = {
        ...manifest.fixedFileHashes!,
        ...(projection.userHash ? { user: projection.userHash } : {})
      };
    }
    const changes = await this.stateChanges(next, remaining, [
      { relativePath: backupFile, content: serializeRecord(target) },
      { relativePath: target.file },
      ...lifecycle.files,
      ...projection.changes
    ], {
      type: "forgotten",
      revision: targetRevision,
      at: this.now(),
      recordId: targetId,
      source,
      ...(toolCallId
        ? { toolCallId: cleanRequired(toolCallId, "toolCallId", 512) }
        : {})
    });
    await this.runTransaction("forget", manifest.revision, targetRevision, changes);
    this.commitSecondaryCache(lifecycle.records);
    return Object.freeze({ revision: targetRevision, forgottenId: targetId });
  }

  private newRecord(input: Readonly<{
    kind: PersonalMemoryKind;
    title: string;
    content: string;
    recallWhen?: string;
    basis: PersonalMemoryBasis;
    targetRevision: number;
    source: string;
    scope?: string;
    asOf?: string;
    supersedes?: string;
    due?: string;
    remindAt?: string;
    reason?: string;
    contentOrigin?: PersonalMemoryContentOrigin;
  }>): PersonalMemoryRecord {
    const id = assertSafeId(this.idFactory());
    return Object.freeze({
      schema: PERSONAL_MEMORY_SCHEMA,
      id,
      kind: input.kind,
      status: "current",
      date: isoDate(this.now()),
      source: input.source,
      basis: input.basis,
      ...(input.contentOrigin ? { contentOrigin: input.contentOrigin } : {}),
      title: cleanRequired(input.title, "title", 200),
      recallWhen: cleanRequired(input.recallWhen ?? input.title, "recall_when", 500),
      content: cleanRequired(input.content, "content", MAX_RECORD_CONTENT_CHARS),
      ...(cleanOptional(input.scope, "scope", 240) ? { scope: cleanOptional(input.scope, "scope", 240)! } : {}),
      ...(input.asOf ? { asOf: validateDate(input.asOf, "as_of") } : {}),
      ...(input.supersedes ? { supersedes: assertSafeId(input.supersedes) } : {}),
      ...(input.due ? { due: validateDateTime(input.due, "due") } : {}),
      ...(input.remindAt ? { remindAt: validateDateTime(input.remindAt, "remind_at") } : {}),
      ...(cleanOptional(input.reason, "reason", 2_000) ? { reason: cleanOptional(input.reason, "reason", 2_000)! } : {}),
      revision: input.targetRevision,
      file: recordRelativePath(input.kind, id)
    });
  }

  private async hydrateCachesFromDisk(): Promise<void> {
    const manifest = await this.readManifestFromDisk();
    const records = await this.readAllRecordsFromDisk(manifest);
    const agent = "";
    const [user, memory] = await Promise.all([
      readUtf8Bounded(this.layout.user, USER_MD_HARD_MAX_BYTES, "USER.md"),
      readBounded(this.layout.memory, MAX_OVERVIEW_CHARS, "MEMORY.md")
    ]);
    const index = await this.readSearchIndexFromDisk(manifest, records);
    this.manifestCache = cloneManifest(manifest);
    this.recordsCache = freezeRecords(records);
    this.searchIndexCache = freezeSearchIndex(index);
    this.fixedContextCache = Object.freeze({ agent, user, memory });
  }

  /**
   * Multiple Repository instances for one Vault share the mutation lane but
   * keep independent read caches. Refresh only when another instance advanced
   * the on-disk revision so create idempotency and write CAS see current state
   * without adding filesystem work to the normal read/recall hot path.
   */
  private async refreshPrimaryCachesBeforeWrite(): Promise<void> {
    const manifest = await this.readManifestFromDisk();
    if (this.manifestCache?.revision === manifest.revision) return;
    const records = await this.readAllRecordsFromDisk(manifest);
    this.manifestCache = cloneManifest(manifest);
    this.recordsCache = freezeRecords(records);
    this.searchIndexCache = null;
    this.fixedContextCache = null;
  }

  private async reconcilePrimaryTargetsBeforeMutation(
    targetIds: readonly string[]
  ): Promise<void> {
    for (const targetId of targetIds) {
      const manifest = await this.readManifest();
      const metadata = manifest.records.find((record) => record.id === targetId);
      if (metadata) await this.refreshKnownPrimaryRecord(metadata.file);
    }
  }

  private async refreshKnownFixedFile(
    relativePath: "shared-user/USER.md"
  ): Promise<void> {
    const manifest = await this.readManifest();
    const records = await this.readAllRecords(manifest);
    const currentFixed = await this.currentFixedContext();
    const profile = "user";
    const target = this.absoluteFromRelative(relativePath);
    const content = await readUtf8Bounded(target, USER_MD_HARD_MAX_BYTES, "USER.md");
    if (content === currentFixed[profile]) return;
    const targetRevision = manifest.revision + 1;
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.fixedFileHashes = {
      ...(manifest.fixedFileHashes ?? {
        agent: contentHash(currentFixed.agent),
        user: contentHash(currentFixed.user)
      }),
      [profile]: contentHash(content)
    };
    const changes = await this.stateChanges(next, records, [], {
      type: "external_markdown_reconciled",
      revision: targetRevision,
      at: this.now(),
      fixedFilesChanged: true,
      recordIds: [],
      deletedIds: []
    });
    await this.runTransaction(
      "external-fixed-file-refresh",
      manifest.revision,
      targetRevision,
      changes
    );
    this.fixedContextCache = Object.freeze({
      ...currentFixed,
      [profile]: content
    });
  }

  private async refreshKnownPrimaryRecord(relativePath: string): Promise<void> {
    const manifest = await this.readManifest();
    const currentRecords = await this.readAllRecords(manifest);
    const existingMetadata = manifest.records.find((record) => record.file === relativePath);
    const target = this.absoluteFromRelative(relativePath);
    await this.assertManagedPathsSafe([target]);
    let parsed: PersonalMemoryRecord | null = null;
    if (await pathExists(target)) {
      parsed = parseRecord(await readFile(target, "utf8"), relativePath);
      if (recordRelativePath(parsed.kind, parsed.id) !== relativePath) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          `Memory ${relativePath} does not match its id and kind`
        );
      }
      const duplicate = manifest.records.find((record) =>
        record.id === parsed!.id && record.file !== relativePath
      );
      if (duplicate) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          `Memory id ${parsed.id} is duplicated`
        );
      }
      if (existingMetadata
        && stableJson(recordMetadata(parsed)) === stableJson(normalizeManifestRecord(existingMetadata))) {
        return;
      }
    } else if (!existingMetadata) {
      return;
    }

    const targetRevision = manifest.revision + 1;
    const external = parsed
      ? Object.freeze({
          ...parsed,
          source: `user-edit://personal-memory/${encodeURIComponent(relativePath)}`,
          basis: "explicit" as const,
          contentOrigin: "user_edit" as const,
          revision: targetRevision
        })
      : null;
    const nextRecords = currentRecords
      .filter((record) => record.file !== relativePath)
      .concat(external ? [external] : [])
      .sort((left, right) => left.id.localeCompare(right.id));
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records = nextRecords.map(recordMetadata);
    const changes = await this.stateChanges(
      next,
      nextRecords,
      external ? [{ relativePath, content: serializeRecord(external) }] : [],
      {
        type: "external_markdown_reconciled",
        revision: targetRevision,
        at: this.now(),
        fixedFilesChanged: false,
        recordIds: external ? [external.id] : [],
        deletedIds: external ? [] : [existingMetadata!.id]
      }
    );
    await this.runTransaction(
      "external-record-refresh",
      manifest.revision,
      targetRevision,
      changes
    );
  }

  private async refreshPrimarySourceDirectories(): Promise<void> {
    const manifest = await this.readManifest();
    const diskRecords = await this.readMarkdownRecords();
    const currentById = new Map(manifest.records.map((record) => [record.id, record]));
    const changed = manifest.records.length !== diskRecords.length
      || diskRecords.some((record) => {
        const metadata = currentById.get(record.id);
        return !metadata
          || stableJson(recordMetadata(record)) !== stableJson(normalizeManifestRecord(metadata));
      });
    if (!changed) return;

    const targetRevision = manifest.revision + 1;
    const changedRecords: PersonalMemoryRecord[] = [];
    const reconciled = diskRecords.map((record) => {
      const metadata = currentById.get(record.id);
      if (metadata
        && stableJson(recordMetadata(record)) === stableJson(normalizeManifestRecord(metadata))) {
        return record;
      }
      const external: PersonalMemoryRecord = Object.freeze({
        ...record,
        source: `user-edit://personal-memory/${encodeURIComponent(record.file)}`,
        basis: "explicit",
        contentOrigin: "user_edit",
        revision: targetRevision
      });
      changedRecords.push(external);
      return external;
    });
    const diskIds = new Set(diskRecords.map((record) => record.id));
    const deletedIds = manifest.records
      .map((record) => record.id)
      .filter((id) => !diskIds.has(id));
    const next = cloneManifest(manifest);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.records = reconciled.map(recordMetadata).sort((left, right) => left.id.localeCompare(right.id));
    const changes = await this.stateChanges(
      next,
      reconciled,
      changedRecords.map((record) => ({
        relativePath: record.file,
        content: serializeRecord(record)
      })),
      {
        type: "external_markdown_reconciled",
        revision: targetRevision,
        at: this.now(),
        fixedFilesChanged: false,
        recordIds: changedRecords.map((record) => record.id),
        deletedIds
      }
    );
    await this.runTransaction(
      "external-source-directory-refresh",
      manifest.revision,
      targetRevision,
      changes
    );
  }

  private async reconcileMarkdownTruth(): Promise<void> {
    await this.assertManagedTreeSafe();
    const [user, markdownRecords, current] = await Promise.all([
      readUtf8Bounded(this.layout.user, USER_MD_HARD_MAX_BYTES, "USER.md"),
      this.readMarkdownRecords(),
      this.readManifestForReconciliation()
    ]);
    const fixedFileHashes: PersonalMemoryFixedFileHashes = Object.freeze({
      // Retain the last mobile-owned hash without opening legacy Agent files.
      // Empty is the explicit desktop-retired placeholder for a new manifest.
      agent: validFixedFileHashes(current?.fixedFileHashes) ? current.fixedFileHashes.agent : contentHash(""),
      user: contentHash(user)
    });

    if (!current) {
      if (utf8Bytes(user) > USER_MD_HARD_MAX_BYTES) {
        throw new PersonalMemoryAccessError(
          "revision_conflict",
          "USER.md exceeds the 128 KiB UTF-8 boundary; automatic repair is blocked"
        );
      }
      const recovered = await this.reconstructRuntimeMetadata(markdownRecords);
      const hasExistingContent = markdownRecords.length > 0
        || user !== defaultUserProfile()
        || recovered.tombstones.length > 0
        || recovered.maxAuditRevision > 0
        || recovered.maxOverviewRevision > 0;
      const revision = hasExistingContent
        ? Math.max(
            0,
            recovered.maxBackupRevision,
            recovered.maxAuditRevision,
            recovered.maxOverviewRevision,
            ...markdownRecords.map((record) => record.revision)
          ) + 1
        : 0;
      const manifest: PersonalMemoryManifest = {
        schemaVersion: 1,
        vaultId: this.vaultId,
        revision,
        records: markdownRecords.map(recordMetadata).sort((a, b) => a.id.localeCompare(b.id)),
        tombstones: recovered.tombstones,
        updatedAt: this.now(),
        fixedFileHashes
      };
      await atomicWrite(this.layout.manifest, jsonText(manifest));
      await atomicWrite(this.layout.searchIndex, jsonText(buildSearchIndexV3(manifest.revision, markdownRecords.map((record) => this.catalogInput(record)), indexableSecondaryRecords(this.secondaryCache))));
      await atomicWrite(this.layout.sourceMap, jsonText(buildSourceMap(manifest)));
      await atomicWrite(this.layout.memory, renderOverview(manifest, markdownRecords));
      if (hasExistingContent) {
        const audit = await readTextOrEmpty(this.layout.audit);
        await atomicWrite(this.layout.audit, `${audit}${JSON.stringify({
          type: "runtime_rebuilt_from_markdown",
          revision,
          at: this.now(),
          recordIds: markdownRecords.map((record) => record.id),
          recoveredTombstoneIds: recovered.tombstones.map((item) => item.recordId)
        })}\n`);
      }
      return;
    }

    const currentById = new Map(current.records.map((record) => [record.id, record]));
    const markdownById = new Map(markdownRecords.map((record) => [record.id, record]));
    const fixedHashesKnown = validFixedFileHashes(current.fixedFileHashes);
    if (utf8Bytes(user) > USER_MD_HARD_MAX_BYTES
      && (!fixedHashesKnown || current.fixedFileHashes!.user !== fixedFileHashes.user)) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "USER.md exceeds the 128 KiB UTF-8 boundary and does not match the trusted manifest hash; automatic repair is blocked"
      );
    }
    const fixedChanged = fixedHashesKnown && (
      current.fixedFileHashes!.user !== fixedFileHashes.user
    );
    const recordsChanged = current.records.length !== markdownRecords.length
      || markdownRecords.some((record) => {
        const metadata = currentById.get(record.id);
        if (!metadata) return true;
        const observed = recordMetadata(record);
        return stableJson(recordMetadataWithoutHash(observed))
          !== stableJson(recordMetadataWithoutHash(normalizeManifestRecord(metadata)))
          || (typeof metadata.contentHash === "string"
            && metadata.contentHash !== observed.contentHash);
      });
    const requiresMetadataUpgrade = !fixedHashesKnown
      || current.records.some((record) =>
        typeof record.contentHash !== "string"
        || typeof record.recallWhen !== "string"
      );

    if (!fixedChanged && !recordsChanged) {
      const upgraded = cloneManifest(current);
      upgraded.records = markdownRecords.map(recordMetadata).sort((a, b) => a.id.localeCompare(b.id));
      upgraded.fixedFileHashes = fixedFileHashes;
      if (requiresMetadataUpgrade) {
        await atomicWrite(this.layout.manifest, jsonText(upgraded));
      }
      await this.repairDerivedFiles(upgraded, markdownRecords);
      return;
    }

    const targetRevision = current.revision + 1;
    const changedRecords: PersonalMemoryRecord[] = [];
    const reconciled = markdownRecords.map((record) => {
      const previous = currentById.get(record.id);
      const observed = recordMetadata(record);
      const unchanged = previous
        && stableJson(recordMetadataWithoutHash(normalizeManifestRecord(previous)))
          === stableJson(recordMetadataWithoutHash(observed))
        && previous.contentHash === observed.contentHash;
      if (unchanged) return record;
      const external: PersonalMemoryRecord = Object.freeze({
        ...record,
        source: `user-edit://personal-memory/${encodeURIComponent(record.file)}`,
        basis: "explicit",
        contentOrigin: "user_edit",
        revision: targetRevision
      });
      changedRecords.push(external);
      return external;
    });
    const next = cloneManifest(current);
    next.revision = targetRevision;
    next.updatedAt = this.now();
    next.fixedFileHashes = fixedFileHashes;
    next.records = reconciled.map(recordMetadata).sort((a, b) => a.id.localeCompare(b.id));
    const deletedIds = current.records
      .map((record) => record.id)
      .filter((id) => !markdownById.has(id));
    const changes = await this.stateChanges(
      next,
      reconciled,
      changedRecords.map((record) => ({
        relativePath: record.file,
        content: serializeRecord(record)
      })),
      {
        type: "external_markdown_reconciled",
        revision: targetRevision,
        at: this.now(),
        fixedFilesChanged: fixedChanged,
        recordIds: changedRecords.map((record) => record.id),
        deletedIds
      }
    );
    await this.runTransaction(
      "external-markdown-reconcile",
      current.revision,
      targetRevision,
      changes
    );
  }

  private async reconstructRuntimeMetadata(
    markdownRecords: readonly PersonalMemoryRecord[]
  ): Promise<Readonly<{
    tombstones: PersonalMemoryTombstone[];
    maxBackupRevision: number;
    maxAuditRevision: number;
    maxOverviewRevision: number;
  }>> {
    const activeIds = new Set(markdownRecords.map((record) => record.id));
    const maxOverviewRevision = parseGeneratedOverviewRevision(
      await readTextOrEmpty(this.layout.memory)
    );
    const tombstones: PersonalMemoryTombstone[] = [];
    let maxBackupRevision = 0;
    for (const [directoryName, reason] of [
      ["forgets", "Recovered from validated forget backup"],
      ["source-deletions", "Recovered from validated source-deletion backup"]
    ] as const) {
      const directory = path.join(this.layout.backups, directoryName);
      for (const backupPath of await listFilesRecursively(directory)) {
        const name = path.basename(backupPath);
        const timestampMatch = name.match(/-(\d+)\.md$/u);
        if (!timestampMatch) continue;
        const forgottenAt = Number(timestampMatch[1]);
        if (!Number.isSafeInteger(forgottenAt) || forgottenAt <= 0) continue;
        const backupFile = path.relative(this.layout.root, backupPath)
          .split(path.sep)
          .join(path.posix.sep);
        let record: PersonalMemoryRecord;
        try {
          record = parseRecord(await readFile(backupPath, "utf8"), backupFile);
        } catch {
          continue;
        }
        if (name !== `${record.id}-${forgottenAt}.md`) continue;
        maxBackupRevision = Math.max(maxBackupRevision, record.revision);
        if (activeIds.has(record.id)) continue;
        tombstones.push({
          recordId: record.id,
          forgottenAt,
          reason,
          backupFile,
          source: record.source
        });
      }
    }
    tombstones.sort((left, right) =>
      left.forgottenAt - right.forgottenAt
      || left.backupFile.localeCompare(right.backupFile)
    );

    let maxAuditRevision = 0;
    for (const line of (await readTextOrEmpty(this.layout.audit)).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const event = parsed as Record<string, unknown>;
        if (
          typeof event.revision === "number"
          && Number.isSafeInteger(event.revision)
          && event.revision >= 0
        ) {
          maxAuditRevision = Math.max(maxAuditRevision, event.revision);
        }
      } catch {
        // A damaged audit line is not reconstruction evidence.
      }
    }
    return Object.freeze({
      tombstones,
      maxBackupRevision,
      maxAuditRevision,
      maxOverviewRevision
    });
  }

  private async readManifestForReconciliation(): Promise<PersonalMemoryManifest | null> {
    if (!(await pathExists(this.layout.manifest))) return null;
    let value: Partial<PersonalMemoryManifest>;
    try {
      value = JSON.parse(await readFile(this.layout.manifest, "utf8")) as Partial<PersonalMemoryManifest>;
    } catch {
      return null;
    }
    if (value.schemaVersion !== 1) {
      throw new PersonalMemoryAccessError(
        "invalid_request",
        "Personal Memory manifest belongs to another Vault or schema"
      );
    }
    if (
      !Number.isSafeInteger(value.revision)
      || !Array.isArray(value.records)
      || !Array.isArray(value.tombstones)
      || value.records.some((record) =>
        !record
        || typeof record !== "object"
        || typeof record.id !== "string"
        || typeof record.file !== "string"
      )
    ) return null;
    if (value.vaultId !== this.vaultId) {
      parseCanonicalMemoryManifest(JSON.stringify(value));
      throw new PersonalMemoryIdentityMismatchError(this.vaultId, String(value.vaultId));
    }
    return value as PersonalMemoryManifest;
  }

  private async readMarkdownRecords(): Promise<PersonalMemoryRecord[]> {
    const records: PersonalMemoryRecord[] = [];
    const ids = new Set<string>();
    for (const directory of [
      this.layout.facts,
      this.layout.views,
      this.layout.decisions,
      this.layout.active,
      this.layout.episodes
    ]) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new PersonalMemoryAccessError("unsafe_path", `Memory record must not be a symlink: ${target}`);
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const relativePath = path.relative(this.layout.root, target).split(path.sep).join(path.posix.sep);
        const parsed = parseRecord(await readFile(target, "utf8"), relativePath);
        if (recordRelativePath(parsed.kind, parsed.id) !== relativePath) {
          throw new PersonalMemoryAccessError(
            "invalid_request",
            `Memory ${relativePath} does not match its id and kind`
          );
        }
        if (ids.has(parsed.id)) {
          throw new PersonalMemoryAccessError("invalid_request", `Memory id ${parsed.id} is duplicated`);
        }
        ids.add(parsed.id);
        records.push(parsed);
      }
    }
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async assertManagedPathsSafe(targets: readonly string[]): Promise<void> {
    const vaultStat = await lstat(this.vaultPath);
    if (vaultStat.isSymbolicLink()) {
      throw new PersonalMemoryAccessError("unsafe_path", "Active Vault root must not be a symlink");
    }
    const vaultRealPath = await realpath(this.vaultPath);
    const paths = new Set<string>();
    for (const target of targets) {
      this.assertManagedPath(target);
      let current = path.resolve(target);
      while (current !== this.vaultPath) {
        paths.add(current);
        current = path.dirname(current);
      }
    }
    for (const target of [...paths].sort((a, b) => a.length - b.length)) {
      await inspectManagedTreeNodeSafety(target, vaultRealPath, { allowMissing: true });
    }
  }

  private async assertManagedTreeSafe(): Promise<void> {
    const vaultStat = await lstat(this.vaultPath);
    if (vaultStat.isSymbolicLink()) {
      throw new PersonalMemoryAccessError("unsafe_path", "Active Vault root must not be a symlink");
    }
    const vaultRealPath = await realpath(this.vaultPath);
    const visit = async (target: string, allowMissing: boolean): Promise<void> => {
      const stat = await inspectManagedTreeNodeSafety(target, vaultRealPath, { allowMissing });
      if (!stat || !stat.isDirectory()) return;
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries) await visit(path.join(target, entry.name), true);
    };
    for (const parent of [this.layout.root]) {
      if (await pathExists(parent)) await inspectManagedTreeNodeSafety(parent, vaultRealPath);
    }
    for (const managedRoot of [this.layout.sharedUser]) {
      if (await pathExists(managedRoot)) await visit(managedRoot, false);
    }
  }

  private async stateChanges(
    manifest: PersonalMemoryManifest,
    records: readonly PersonalMemoryRecord[],
    extra: readonly TransactionChange[],
    audit: Readonly<Record<string, unknown>>,
    secondaryForIndex?: readonly SecondaryMemoryRecord[]
  ): Promise<TransactionChange[]> {
    const secondarySnapshot = secondaryForIndex ?? this.secondaryCache;
    await this.assertManagedPathsSafe([this.layout.audit]);
    const previousAudit = await readTextOrEmpty(this.layout.audit);
    return dedupeChanges([
      ...extra,
      { relativePath: path.relative(this.layout.root, this.layout.manifest), content: jsonText(manifest) },
      { relativePath: path.relative(this.layout.root, this.layout.searchIndex), content: jsonText(buildSearchIndexV3(manifest.revision, records.map((record) => this.catalogInput(record)), indexableSecondaryRecords(secondarySnapshot))) },
      { relativePath: path.relative(this.layout.root, this.layout.sourceMap), content: jsonText(buildSourceMap(manifest)) },
      { relativePath: path.relative(this.layout.root, this.layout.memory), content: renderOverview(manifest, records) },
      {
        relativePath: path.relative(this.layout.root, this.layout.audit),
        content: `${previousAudit}${JSON.stringify(audit)}\n`
      }
    ]);
  }

  private async runTransaction(
    operation: string,
    baseRevision: number,
    targetRevision: number,
    changes: readonly TransactionChange[]
  ): Promise<void> {
    const currentManifest = await this.readManifestFromDisk();
    assertExpectedRevision(currentManifest, baseRevision);
    this.rememberInternalWatchExpectations(changes);
    const transactionId = `txn_${randomUUID().replaceAll("-", "")}`;
    const transactionRoot = path.join(this.layout.transactions, transactionId);
    const backupRoot = path.join(transactionRoot, "backup");
    await this.assertManagedPathsSafe([
      backupRoot,
      ...changes.map((change) => this.absoluteFromRelative(change.relativePath))
    ]);
    await mkdir(backupRoot, { recursive: true });
    const entries: TransactionPlanEntry[] = [];
    for (const [index, change] of changes.entries()) {
      const target = this.absoluteFromRelative(change.relativePath);
      const existed = await pathExists(target);
      if (existed) {
        const backupFile = path.join("backup", `${index}.bak`);
        await copyFile(target, path.join(transactionRoot, backupFile));
        entries.push({ relativePath: change.relativePath, existed: true, backupFile });
      } else {
        entries.push({ relativePath: change.relativePath, existed: false });
      }
    }
    const plan: TransactionPlan = {
      schemaVersion: 1,
      transactionId,
      operation,
      baseRevision,
      targetRevision,
      entries
    };
    await atomicWrite(path.join(transactionRoot, "plan.json"), jsonText(plan));
    await atomicWrite(path.join(transactionRoot, "state"), "applying\n");
    let simulatedCrash = false;
    try {
      let appliedChanges = 0;
      for (const change of changes) {
        const target = this.absoluteFromRelative(change.relativePath);
        await this.assertManagedPathsSafe([target]);
        if (change.content === undefined) {
          if (await pathExists(target)) await unlink(target);
        } else {
          await atomicWrite(target, change.content);
        }
        appliedChanges += 1;
        if (await this.failTransactionAfterChange?.(operation, appliedChanges)) {
          simulatedCrash = true;
          throw new Error("personal_memory_simulated_crash");
        }
      }
      await atomicWrite(path.join(transactionRoot, "state"), "committed\n");
      await rm(transactionRoot, { recursive: true, force: true });
      this.applyCommittedChangesToCaches(changes);
    } catch (error) {
      if (!simulatedCrash) await this.rollbackTransaction(transactionRoot, plan);
      throw error;
    }
  }

  private rememberInternalWatchExpectations(changes: readonly TransactionChange[]): void {
    const until = Date.now() + 2_000;
    for (const [relativePath, expectation] of this.internalWatchExpectations) {
      if (expectation.until < Date.now()) this.internalWatchExpectations.delete(relativePath);
    }
    for (const change of changes) {
      if (!this.isKnownExternalPath(change.relativePath)) continue;
      this.internalWatchExpectations.set(change.relativePath, Object.freeze({
        hash: change.content === undefined ? null : contentHash(change.content),
        until
      }));
    }
  }

  private applyCommittedChangesToCaches(changes: readonly TransactionChange[]): void {
    let manifest = this.manifestCache;
    let records = this.recordsCache ? [...this.recordsCache] : null;
    let fixed = this.fixedContextCache ? { ...this.fixedContextCache } : null;
    for (const change of changes) {
      if (change.relativePath === "shared-user/.runtime/manifest.json" && change.content !== undefined) {
        const parsed = JSON.parse(change.content) as PersonalMemoryManifest;
        manifest = {
          ...parsed,
          records: parsed.records.map((record) => normalizeManifestRecord(record))
        };
        continue;
      }
      if (change.relativePath === "shared-user/.runtime/search-index.json" && change.content !== undefined) {
        this.searchIndexCache = freezeSearchIndex(JSON.parse(change.content) as SearchIndex);
        continue;
      }
      if (change.relativePath === "shared-user/USER.md" && change.content !== undefined) {
        if (fixed) fixed.user = change.content;
        continue;
      }
      if (change.relativePath === "shared-user/MEMORY.md" && change.content !== undefined) {
        if (fixed) fixed.memory = change.content;
        continue;
      }
      if (!records || !isPrimaryRecordRelativePath(change.relativePath)) continue;
      const position = records.findIndex((record) => record.file === change.relativePath);
      if (change.content === undefined) {
        if (position >= 0) records.splice(position, 1);
      } else {
        const parsed = parseRecord(change.content, change.relativePath);
        if (position >= 0) records[position] = parsed;
        else records.push(parsed);
      }
    }
    if (manifest) {
      this.manifestCache = cloneManifest(manifest);
      if (records) {
        const manifestIds = new Set(manifest.records.map((record) => record.id));
        records = records.filter((record) => manifestIds.has(record.id));
        const recordsById = new Map(records.map((record) => [record.id, record]));
        const complete = manifest.records.every((metadata) => {
          const record = recordsById.get(metadata.id);
          return record
            && stableJson(recordMetadata(record)) === stableJson(normalizeManifestRecord(metadata));
        });
        this.recordsCache = complete ? freezeRecords(records) : null;
      }
    }
    if (fixed) this.fixedContextCache = Object.freeze(fixed);
  }

  private async recoverPendingTransactions(): Promise<void> {
    if (!(await pathExists(this.layout.transactions))) return;
    const entries = await readdir(this.layout.transactions, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transactionRoot = path.join(this.layout.transactions, entry.name);
      if (entry.name.startsWith("txn_mobile_")) throw new PersonalMemoryAccessError("revision_conflict", "Mobile Memory transaction requires its owner recovery; desktop did not alter it");
      const planPath = path.join(transactionRoot, "plan.json");
      if (!(await pathExists(planPath))) {
        await rm(transactionRoot, { recursive: true, force: true });
        continue;
      }
      const plan = JSON.parse(await readFile(planPath, "utf8")) as TransactionPlan;
      const ownedPlan = plan as TransactionPlan & { owner?: unknown; ownerId?: unknown };
      if (ownedPlan.owner !== undefined || ownedPlan.ownerId !== undefined) throw new PersonalMemoryAccessError("revision_conflict", "Foreign Memory transaction requires its owner recovery; desktop did not alter it");
      const state = (await readTextOrEmpty(path.join(transactionRoot, "state"))).trim();
      if (state === "committed") {
        await rm(transactionRoot, { recursive: true, force: true });
      } else {
        await this.rollbackTransaction(transactionRoot, plan);
      }
    }
  }

  private async rollbackTransaction(transactionRoot: string, plan: TransactionPlan): Promise<void> {
    for (const entry of [...plan.entries].reverse()) {
      const target = this.absoluteFromRelative(entry.relativePath);
      if (entry.existed && entry.backupFile) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(transactionRoot, entry.backupFile), target);
      } else if (await pathExists(target)) {
        await unlink(target);
      }
    }
    await rm(transactionRoot, { recursive: true, force: true });
  }

  private async repairDerivedFiles(manifest: PersonalMemoryManifest, records: readonly PersonalMemoryRecord[]): Promise<void> {
    const index = await readJsonOrNull<SearchIndex>(this.layout.searchIndex);
    const sourceMap = await readJsonOrNull<SourceMapFile>(this.layout.sourceMap);
    const expectedIndex = buildSearchIndexV3(manifest.revision, records.map((record) => this.catalogInput(record)), indexableSecondaryRecords(this.secondaryCache));
    const expectedSourceMap = buildSourceMap(manifest);
    if (!index || stableJson(index) !== stableJson(expectedIndex)) {
      await atomicWrite(this.layout.searchIndex, jsonText(expectedIndex));
    }
    this.searchIndexCache = freezeSearchIndex(expectedIndex);
    if (!sourceMap || stableJson(sourceMap) !== stableJson(expectedSourceMap)) {
      await atomicWrite(this.layout.sourceMap, jsonText(expectedSourceMap));
    }
  }

  private async readSearchIndexSnapshot(
    manifest: PersonalMemoryManifest
  ): Promise<Readonly<SearchIndex>> {
    if (this.searchIndexCache?.revision === manifest.revision) {
      return this.searchIndexCache;
    }
    const records = await this.readAllRecords(manifest);
    const index = await this.readSearchIndexFromDisk(manifest, records);
    this.searchIndexCache = freezeSearchIndex(index);
    return this.searchIndexCache;
  }

  private async readSearchIndexFromDisk(
    manifest: PersonalMemoryManifest,
    records: readonly PersonalMemoryRecord[]
  ): Promise<Readonly<SearchIndex>> {
    const raw = await readJsonOrNull<Record<string, unknown>>(this.layout.searchIndex);
    const index = raw as unknown as SearchIndex | null;
    const needsRebuild = !index
      || index.schemaVersion !== 3
      || index.revision !== manifest.revision
      || !isArrayValue(index.catalog)
      || !isArrayValue(index.secondaryCatalog)
      || !isArrayValue(index.secondaryIndex)
      || index.catalog.some((record) =>
        !Array.isArray(record.routeTokens)
        || !Array.isArray(record.contentTokens)
        || typeof record.summary !== "string"
      )
      || typeof index.checksum !== "string"
      || index.checksum !== indexChecksum(
        index.revision,
        index.catalog,
        index.secondaryCatalog,
        index.secondaryIndex
      );
    if (needsRebuild) {
      // v2 (and stale/corrupt v3) indexes are derived artifacts: rebuild as v3.
      return await this.rebuildSearchIndexForManifest(manifest, records);
    }
    const manifestIds = new Set(manifest.records.map((record) => record.id));
    if (
      index.catalog.length !== manifestIds.size
      || index.catalog.some((record) => !manifestIds.has(record.id))
      || index.secondaryCatalog.some((entry) => !manifestIds.has(entry.parentId))
    ) {
      return await this.rebuildSearchIndexForManifest(manifest, records);
    }
    return freezeSearchIndex(index);
  }

  private async rebuildSearchIndexForManifest(
    manifest: PersonalMemoryManifest,
    knownRecords?: readonly PersonalMemoryRecord[]
  ): Promise<Readonly<SearchIndex>> {
    const records = knownRecords ?? await this.readAllRecords(manifest);
    const rebuilt = buildSearchIndexV3(
      manifest.revision,
      records.map((record) => this.catalogInput(record)),
      indexableSecondaryRecords(this.secondaryCache)
    );
    await atomicWrite(this.layout.searchIndex, jsonText(rebuilt));
    this.searchIndexCache = freezeSearchIndex(rebuilt);
    return this.searchIndexCache;
  }

  private async readManifest(): Promise<PersonalMemoryManifest> {
    if (this.manifestCache) return cloneManifest(this.manifestCache);
    const manifest = await this.readManifestFromDisk();
    this.manifestCache = cloneManifest(manifest);
    return cloneManifest(manifest);
  }

  private async readManifestFromDisk(): Promise<PersonalMemoryManifest> {
    const value = JSON.parse(await readFile(this.layout.manifest, "utf8")) as Partial<PersonalMemoryManifest>;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)) {
      throw new PersonalMemoryAccessError("invalid_request", "Personal Memory manifest is invalid or belongs to another Vault");
    }
    if (!Array.isArray(value.records) || !Array.isArray(value.tombstones)) {
      throw new PersonalMemoryAccessError("invalid_request", "Personal Memory manifest collections are invalid");
    }
    if (value.vaultId !== this.vaultId) {
      parseCanonicalMemoryManifest(JSON.stringify(value));
      throw new PersonalMemoryIdentityMismatchError(this.vaultId, String(value.vaultId));
    }
    return {
      ...value,
      records: value.records.map((record) => normalizeManifestRecord(record))
    } as PersonalMemoryManifest;
  }

  private async readAllRecords(manifest: PersonalMemoryManifest): Promise<PersonalMemoryRecord[]> {
    if (this.recordsCache && this.manifestCache?.revision === manifest.revision) {
      return [...this.recordsCache];
    }
    const records = await this.readAllRecordsFromDisk(manifest);
    this.recordsCache = freezeRecords(records);
    return [...this.recordsCache];
  }

  private async readAllRecordsFromDisk(manifest: PersonalMemoryManifest): Promise<PersonalMemoryRecord[]> {
    const records = await Promise.all(
      manifest.records.map(async (record) => await this.readRecordFromDisk(record))
    );
    records.sort((a, b) => a.id.localeCompare(b.id));
    return records;
  }

  private async readRecord(metadata: ManifestRecord): Promise<PersonalMemoryRecord> {
    if (this.recordsCache) {
      const cached = this.recordsCache.find((record) => record.id === metadata.id);
      if (!cached || stableJson(recordMetadata(cached)) !== stableJson(metadata)) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          `Memory metadata drift detected for ${metadata.id}`
        );
      }
      return cached;
    }
    return await this.readRecordFromDisk(metadata);
  }

  private async readRecordFromDisk(metadata: ManifestRecord): Promise<PersonalMemoryRecord> {
    const target = this.absoluteFromRelative(metadata.file);
    await this.assertManagedPathsSafe([target]);
    const parsed = parseRecord(await readFile(target, "utf8"), metadata.file);
    if (stableJson(recordMetadata(parsed)) !== stableJson(metadata)) {
      throw new PersonalMemoryAccessError("invalid_request", `Memory metadata drift detected for ${metadata.id}`);
    }
    return parsed;
  }

  private async assertFixedFilesMatchManifest(manifest: PersonalMemoryManifest): Promise<void> {
    if (!validFixedFileHashes(manifest.fixedFileHashes)) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "Identity file hashes are unavailable; reload before writing"
      );
    }
    await this.assertManagedPathsSafe([this.layout.user]);
    const user = await readUtf8Bounded(this.layout.user, USER_MD_HARD_MAX_BYTES, "USER.md");
    if (
      contentHash(user) !== manifest.fixedFileHashes.user
    ) {
      throw new PersonalMemoryAccessError(
        "revision_conflict",
        "USER.md changed after initialization; reload before writing"
      );
    }
  }

  private assertRuntime(runtime: Readonly<PersonalMemoryRuntimeContext>): void {
    if (runtime.vaultId !== this.vaultId) {
      throw new PersonalMemoryAccessError("vault_mismatch", "Memory access is bound to another Vault");
    }
    for (const [name, value] of Object.entries({
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId,
      userEntryId: runtime.userEntryId
    })) cleanRequired(value, name, 512);
    if (runtime.memoryMode === "no_memory") {
      throw new PersonalMemoryAccessError("no_memory", "Historical Memory is disabled for this Conversation");
    }
  }

  private assertRecallRuntime(runtime: Readonly<PersonalMemoryRecallRuntimeContext>): void {
    if (runtime.vaultId !== this.vaultId) {
      throw new PersonalMemoryAccessError("vault_mismatch", "Memory access is bound to another Vault");
    }
    for (const [name, value] of Object.entries({
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId
    })) cleanRequired(value, name, 512);
    if (runtime.memoryMode !== "normal") {
      throw new PersonalMemoryAccessError(
        "invalid_request",
        "Personal Memory Recall runtime must use normal mode"
      );
    }
  }

  private assertManagedPath(target: string): void {
    const relative = path.relative(this.vaultPath, path.resolve(target));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PersonalMemoryAccessError("unsafe_path", "Managed Memory path escapes the active Vault");
    }
  }

  private absoluteFromRelative(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new PersonalMemoryAccessError("unsafe_path", "Memory relative path is invalid");
    }
    const target = path.resolve(this.layout.root, relativePath);
    const relative = path.relative(this.layout.root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PersonalMemoryAccessError("unsafe_path", "Memory path escapes .echoink");
    }
    return target;
  }

  private async assertNotSymlink(target: string): Promise<void> {
    if (!(await pathExists(target))) return;
    if ((await lstat(target)).isSymbolicLink()) {
      throw new PersonalMemoryAccessError("unsafe_path", `Managed Memory directory must not be a symlink: ${target}`);
    }
  }

  private async assertNoMobileTransactions(): Promise<void> {
    const directory = path.join(this.layout.runtime, "mobile-transactions");
    if (await pathExists(directory)) for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && (await readTextOrEmpty(path.join(directory, entry.name, "state"))).trim() !== "committed") throw new PersonalMemoryAccessError("revision_conflict", "Mobile Memory transaction is pending; desktop did not read or alter half-written data");
    }
    if (await pathExists(this.layout.transactions)) for (const entry of await readdir(this.layout.transactions, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("txn_mobile_")) throw new PersonalMemoryAccessError("revision_conflict", "Legacy Mobile Memory transaction requires its owner recovery");
      const plan = await readJsonOrNull<Record<string, unknown>>(path.join(this.layout.transactions, entry.name, "plan.json"));
      if (plan?.owner !== undefined || plan?.ownerId !== undefined) throw new PersonalMemoryAccessError("revision_conflict", "Foreign Memory transaction requires its owner recovery");
    }
  }

  private async withMutation<T>(callback: () => Promise<T>): Promise<T> {
    const previous = mutationLanes.get(this.layout.root) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (this.disposed) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          "Personal Memory Repository is disposed"
        );
      }
      await this.assertNoMobileTransactions();
      return await callback();
    });
    mutationLanes.set(this.layout.root, current);
    try {
      return await current;
    } finally {
      if (mutationLanes.get(this.layout.root) === current) mutationLanes.delete(this.layout.root);
    }
  }
}

function cloneManifest(manifest: PersonalMemoryManifest): PersonalMemoryManifest {
  return structuredClone(manifest);
}

interface PrimaryCreateSemantics {
  readonly kind: PersonalMemoryKind;
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
  readonly basis: PersonalMemoryBasis;
  readonly contentOrigin: PersonalMemoryContentOrigin;
  readonly scope?: string;
  readonly asOf?: string;
  readonly due?: string;
  readonly remindAt?: string;
  readonly reason?: string;
}

function normalizeCreateSemantics(
  request: Extract<PersonalMemoryWriteRequest, { operation: "create" }>
): PrimaryCreateSemantics {
  const title = cleanRequired(request.title, "title", 200);
  const scope = cleanOptional(request.scope, "scope", 240);
  const reason = cleanOptional(request.reason, "reason", 2_000);
  return Object.freeze({
    kind: request.kind,
    title,
    content: cleanRequired(request.content, "content", MAX_RECORD_CONTENT_CHARS),
    recallWhen: cleanRequired(request.recallWhen ?? title, "recall_when", 500),
    basis: request.basis,
    contentOrigin: request.contentOrigin ?? "user_statement",
    ...(scope ? { scope } : {}),
    ...(request.asOf ? { asOf: validateDate(request.asOf, "as_of") } : {}),
    ...(request.due ? { due: validateDateTime(request.due, "due") } : {}),
    ...(request.remindAt ? { remindAt: validateDateTime(request.remindAt, "remind_at") } : {}),
    ...(reason ? { reason } : {})
  });
}

function sameCreateSemantics(
  record: PersonalMemoryRecord,
  semantics: PrimaryCreateSemantics
): boolean {
  return stableJson({
    kind: record.kind,
    title: record.title,
    content: record.content,
    recallWhen: record.recallWhen,
    basis: record.basis,
    contentOrigin: record.contentOrigin ?? "user_statement",
    scope: record.scope ?? null,
    asOf: record.asOf ?? null,
    due: record.due ?? null,
    remindAt: record.remindAt ?? null,
    reason: record.reason ?? null
  }) === stableJson({
    ...semantics,
    scope: semantics.scope ?? null,
    asOf: semantics.asOf ?? null,
    due: semantics.due ?? null,
    remindAt: semantics.remindAt ?? null,
    reason: semantics.reason ?? null
  });
}

function primaryBroadKey(
  kind: PersonalMemoryKind,
  title: string,
  scope: string | undefined
): string {
  const normalize = (value: string): string => value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/\s+/gu, " ")
    .trim();
  return `${kind}\u0000${normalize(title)}\u0000${normalize(scope ?? "")}`;
}

function freezeRecords(records: readonly PersonalMemoryRecord[]): readonly PersonalMemoryRecord[] {
  return Object.freeze([...records]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => Object.freeze({ ...record })));
}

function freezeSearchIndex(index: Readonly<SearchIndex>): Readonly<SearchIndex> {
  return Object.freeze({
    ...index,
    catalog: Object.freeze(index.catalog.map((record) => Object.freeze({
      ...record,
      routeTokens: Object.freeze([...record.routeTokens]),
      contentTokens: Object.freeze([...record.contentTokens])
    }))),
    secondaryCatalog: Object.freeze(index.secondaryCatalog.map((entry) => Object.freeze({
      ...entry,
      matchTerms: Object.freeze([...entry.matchTerms]),
      routeTokens: Object.freeze([...entry.routeTokens]),
      contentTokens: Object.freeze([...entry.contentTokens])
    }))),
    secondaryIndex: Object.freeze(index.secondaryIndex.map((entry) => Object.freeze({ ...entry })))
  });
}

function normalizeManagedRelativePath(value: string): string {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw new PersonalMemoryAccessError("unsafe_path", "Memory relative path is invalid");
  }
  const normalized = path.posix.normalize(value.replaceAll(path.sep, path.posix.sep));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new PersonalMemoryAccessError("unsafe_path", "Memory relative path is invalid");
  }
  return normalized.replace(/^\.\//u, "");
}

function isPrimaryRecordRelativePath(relativePath: string): boolean {
  return /^shared-user\/memory\/(?:facts|views|decisions|active|episodes)\/[a-zA-Z0-9_-]{3,96}\.md$/u
    .test(relativePath);
}

export function defaultUserProfile(): string {
  return [
    "# USER",
    "",
    "这里保存用户明确确认的当前稳定画像与合作方式。",
    "",
    "- 尚无已确认内容。",
    ""
  ].join("\n");
}

function defaultMemoryOverview(): string {
  return [
    "# Memory",
    "",
    "这里是长期 Memory 的有界 Overview。详细历史按需通过 Memory Tool 读取。",
    "",
    "- facts/",
    "- views/",
    "- decisions/",
    "- active/",
    "- episodes/",
    ""
  ].join("\n");
}


function parseGeneratedOverviewRevision(
  value: string
): number {
  const lines = value.split("\n");
  if (
    lines[0] !== "# Memory"
    || lines[1] !== ""
    || lines[3] !== ""
    || lines[4] !== GENERATED_OVERVIEW_SENTINEL
    || lines[5] !== ""
  ) return 0;
  const revisionLines = lines.filter((line) => line.startsWith("Revision:"));
  if (revisionLines.length !== 1 || revisionLines[0] !== lines[2]) return 0;
  const match = /^Revision: (0|[1-9]\d*)$/u.exec(lines[2] ?? "");
  if (!match) return 0;
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision < 0) return 0;
  return revision;
}

const renderExport = renderCanonicalMemoryExport;

const serializeRecord = serializeCanonicalMemoryRecord;
export function parsePersonalMemoryRecord(text: string, file: string): PersonalMemoryRecord {
  try { return parseCanonicalMemoryRecord(text, file); }
  catch (error) { if (error instanceof CanonicalMemoryFormatError) throw new PersonalMemoryAccessError(error.code, error.message); throw error; }
}

const parseRecord = parsePersonalMemoryRecord;

function recordMetadata(record: Readonly<PersonalMemoryRecord>): ManifestRecord {
  const { content: _content, ...metadata } = record;
  return { ...metadata, contentHash: contentHash(record.content) };
}

function normalizeManifestRecord(record: Readonly<ManifestRecord>): ManifestRecord {
  return typeof record.recallWhen === "string" && record.recallWhen.trim()
    ? record
    : { ...record, recallWhen: record.title };
}

function recordMetadataWithoutHash(
  record: Readonly<ManifestRecord>
): Omit<ManifestRecord, "contentHash"> {
  const { contentHash: _contentHash, ...metadata } = record;
  return metadata;
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validFixedFileHashes(
  value: PersonalMemoryFixedFileHashes | undefined
): value is PersonalMemoryFixedFileHashes {
  return Boolean(
    value
    && /^[a-f0-9]{64}$/u.test(value.agent)
    && /^[a-f0-9]{64}$/u.test(value.user)
  );
}

function buildSourceMap(manifest: PersonalMemoryManifest): SourceMapFile {
  const sources = new Map<string, string[]>();
  for (const record of manifest.records) {
    const current = sources.get(record.source) ?? [];
    current.push(record.id);
    sources.set(record.source, current);
  }
  return {
    schemaVersion: 1,
    revision: manifest.revision,
    sources: Object.fromEntries([...sources.entries()].map(([source, ids]) => [source, ids.sort(compareText)]))
  };
}

function runtimeSource(runtime: Readonly<PersonalMemoryRuntimeContext>): string {
  const segments = [runtime.vaultId, runtime.conversationId, runtime.piSessionId, runtime.userEntryId]
    .map((value) => encodeURIComponent(value));
  return `pi://${segments.join("/")}?productRun=${encodeURIComponent(runtime.productRunId)}`;
}

function runtimeAuditLink(
  runtime: Readonly<PersonalMemoryRuntimeContext>
): Readonly<{ toolCallId?: string }> {
  return runtime.toolCallId
    ? Object.freeze({ toolCallId: cleanRequired(runtime.toolCallId, "toolCallId", 512) })
    : Object.freeze({});
}

function productRunIdFromRuntimeSource(source: string): string | null {
  if (!source.startsWith("pi://")) return null;
  const query = source.split("?", 2)[1];
  if (!query) return null;
  const productRunId = new URLSearchParams(query).get("productRun");
  return productRunId?.trim() || null;
}

function validateWriteContent(
  kind: PersonalMemoryKind,
  basis: PersonalMemoryBasis,
  origin: PersonalMemoryContentOrigin | undefined,
  explicitlyAuthorized: boolean
): void {
  if (basis !== "explicit" && kind !== "view") {
    throw new PersonalMemoryAccessError("invalid_request", "Observed and inferred content is limited to views");
  }
  const effectiveOrigin = origin ?? "user_statement";
  const unsafeAutomaticOrigins: readonly PersonalMemoryContentOrigin[] = [
    "current_instruction", "quotation", "code", "hypothesis", "knowledge", "tool_output"
  ];
  if (unsafeAutomaticOrigins.includes(effectiveOrigin) && !explicitlyAuthorized) {
    throw new PersonalMemoryAccessError("invalid_request", `${effectiveOrigin} cannot become durable Memory automatically`);
  }
  if (["knowledge", "tool_output"].includes(effectiveOrigin) && ["fact", "view", "decision"].includes(kind)) {
    throw new PersonalMemoryAccessError("invalid_request", `${effectiveOrigin} cannot become a user ${kind}`);
  }
}

function assertUserProfileControlRevision(expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new PersonalMemoryAccessError("invalid_request", "User profile control requires a committed revision");
  }
}

function assertExpectedRevision(manifest: PersonalMemoryManifest, expected: number | undefined): void {
  if (expected !== undefined && expected !== manifest.revision) {
    throw new PersonalMemoryAccessError(
      "revision_conflict",
      `Memory revision conflict: expected ${expected}, current ${manifest.revision}`
    );
  }
}

function recordRelativePath(kind: PersonalMemoryKind, id: string): string {
  const directory = kind === "fact"
    ? "facts"
    : kind === "view"
      ? "views"
      : kind === "decision"
        ? "decisions"
        : kind === "episode"
          ? "episodes"
          : "active";
  return path.posix.join("shared-user", "memory", directory, `${assertSafeId(id)}.md`);
}

function bestSecondaryScores(
  index: Readonly<SearchIndex>,
  query: string,
  queryTokens: ReadonlySet<string>
): Map<string, { score: number; entry: SecondaryCatalogEntry }> {
  const best = new Map<string, { score: number; entry: SecondaryCatalogEntry }>();
  if (!query.trim()) return best;
  for (const entry of index.secondaryCatalog) {
    const score = scoreSecondaryEntry(entry, query, queryTokens);
    if (score <= 0) continue;
    const current = best.get(entry.parentId);
    if (!current || score > current.score) best.set(entry.parentId, { score, entry });
  }
  return best;
}

function groupSecondaryMatches(
  index: Readonly<SearchIndex>,
  query: string,
  queryTokens: ReadonlySet<string>
): Map<string, SecondaryCatalogEntry[]> {
  const matches = new Map<string, SecondaryCatalogEntry[]>();
  if (!query.trim()) return matches;
  for (const entry of index.secondaryCatalog) {
    if (scoreSecondaryEntry(entry, query, queryTokens) <= 0) continue;
    const list = matches.get(entry.parentId) ?? [];
    list.push(entry);
    matches.set(entry.parentId, list);
  }
  return matches;
}

function matchesRecallScope(recordScope: string | undefined, requestedScope: string | undefined): boolean {
  if (!requestedScope) return true;
  const scope = recordScope?.trim().toLocaleLowerCase();
  return !scope
    || scope === "global"
    || scope.replace(/^project:/u, "").trim() === requestedScope.replace(/^project:/u, "").trim();
}

function searchItemIdentity(record: Omit<PersonalMemoryRecord, "content">): Pick<PersonalMemorySearchItem,
  "status" | "basis" | "sourceSummary" | "contentOrigin" | "scope" | "asOf" | "supersedes" | "revision" | "file"
> {
  return {
    status: record.status,
    basis: record.basis,
    sourceSummary: summarize(summarizeSource(record.source)),
    ...(record.contentOrigin ? { contentOrigin: record.contentOrigin } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
    ...(record.asOf ? { asOf: record.asOf } : {}),
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
    revision: record.revision,
    file: record.file
  };
}

function toSecondaryMatchView(
  entry: SecondaryCatalogEntry,
  cached?: SecondaryMemoryRecord
): SecondaryMatchView {
  const support = cached?.parentId === entry.parentId ? cached : undefined;
  return Object.freeze({
    id: entry.id,
    parentId: entry.parentId,
    title: entry.title,
    content: entry.content,
    recallWhen: entry.recallWhen,
    matchTerms: Object.freeze([...entry.matchTerms]),
    relation: entry.relation,
    basis: entry.basis,
    ...(support?.status ? { status: support.status } : {}),
    ...(support?.supportLevel ? { supportLevel: support.supportLevel } : {}),
    ...(support?.evidence ? { evidence: support.evidence } : {}),
    ...(support?.sourceMemoryRevision !== undefined
      ? { sourceMemoryRevision: support.sourceMemoryRevision }
      : {})
  });
}

function encodeSearchCursor(revision: number, fingerprint: string, offset: number): string {
  const payload = stableJson({ version: 1, revision, fingerprint, offset });
  const signature = contentHash(payload).slice(0, 24);
  return Buffer.from(stableJson({ payload, signature }), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: string, revision: number, fingerprint: string): number {
  const encoded = cleanRequired(cursor, "cursor", MAX_CURSOR_CHARS);
  let payload: Record<string, unknown>;
  try {
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      payload?: unknown;
      signature?: unknown;
    };
    if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error();
    if (contentHash(envelope.payload).slice(0, 24) !== envelope.signature) throw new Error();
    payload = JSON.parse(envelope.payload) as Record<string, unknown>;
    if (
      payload.version !== 1
      || !Number.isSafeInteger(payload.offset)
      || (payload.offset as number) < 0
    ) throw new Error();
  } catch {
    throw new PersonalMemoryAccessError("invalid_request", "memory_search cursor is invalid");
  }
  if (payload.revision !== revision) {
    throw new PersonalMemoryAccessError("revision_conflict", "memory_search cursor revision has changed");
  }
  if (payload.fingerprint !== fingerprint) {
    throw new PersonalMemoryAccessError("invalid_request", "memory_search cursor does not match query or filters");
  }
  return payload.offset as number;
}

function summarize(content: string): string {
  const compact = content.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}…`;
}

function summarizeSource(source: string): string {
  if (source.startsWith("pi://")) {
    const [base] = source.split("?");
    const segments = base.split("/");
    return `pi://…/${segments.at(-2) ?? "session"}/${segments.at(-1) ?? "entry"}`;
  }
  return source;
}

function cleanRequired(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string") throw new PersonalMemoryAccessError("invalid_request", `${name} must be text`);
  const clean = value.trim();
  if (!clean || clean.length > maxChars || hasDisallowedControlCharacters(clean)) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} is empty, too large, or contains control characters`);
  }
  return clean;
}

function normalizeProfileWrite(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new PersonalMemoryAccessError("invalid_request", `${name} must be text`);
  }
  const clean = value.trim();
  if (!clean || hasDisallowedControlCharacters(clean)) {
    throw new PersonalMemoryAccessError(
      "invalid_request",
      `${name} is empty or contains control characters`
    );
  }
  const normalized = clean.endsWith("\n") ? clean : `${clean}\n`;
  const bytes = utf8Bytes(normalized);
  if (bytes > maxBytes) {
    throw new PersonalMemoryAccessError(
      "invalid_request",
      `${name} exceeds ${maxBytes} UTF-8 bytes`
    );
  }
  return normalized;
}

function normalizeUserProfileWrite(value: unknown, name: string): string {
  return normalizeProfileWrite(value, name, USER_MD_HARD_MAX_BYTES);
}


function cleanOptional(value: unknown, name: string, maxChars: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return cleanRequired(value, name, maxChars);
}

function assertSafeId(value: unknown): string {
  const id = cleanRequired(value, "id", 96);
  if (!SAFE_ID.test(id)) throw new PersonalMemoryAccessError("invalid_request", "Memory id is unsafe");
  return id;
}

function validateDate(value: unknown, name: string): string {
  const date = cleanRequired(value, name, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} must be YYYY-MM-DD`);
  }
  return date;
}

function validateDateTime(value: unknown, name: string): string {
  const dateTime = cleanRequired(value, name, 64);
  if (Number.isNaN(Date.parse(dateTime))) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} must be an ISO date-time`);
  }
  return dateTime;
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function dedupeChanges(changes: readonly TransactionChange[]): TransactionChange[] {
  const byPath = new Map<string, TransactionChange>();
  for (const change of changes) {
    // Transactions, cache keys and watcher expectations share POSIX paths on
    // every desktop platform, including paths produced by Windows relative().
    const relativePath = normalizeManagedRelativePath(change.relativePath);
    byPath.set(relativePath, { ...change, relativePath });
  }
  return [...byPath.values()];
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

export interface ManagedTreeNodeSafetyFileSystem {
  readonly lstat: (target: string) => Promise<Stats>;
  readonly realpath: (target: string) => Promise<string>;
}

export interface ManagedTreeNodeSafetyOptions {
  /** Only recursive child entries observed by readdir may disappear normally. */
  readonly allowMissing?: boolean;
  readonly fileSystem?: ManagedTreeNodeSafetyFileSystem;
}

const MANAGED_TREE_NODE_SAFETY_FILE_SYSTEM: ManagedTreeNodeSafetyFileSystem = Object.freeze({
  lstat,
  realpath
});

/**
 * Validate one node observed during a managed-tree walk. Atomic writers may
 * rename a UUID temporary file after readdir/lstat but before realpath. Only a
 * second ENOENT confirming that the same node is now absent is treated as a
 * harmless disappearance; every extant replacement is still fail-closed.
 */
export async function inspectManagedTreeNodeSafety(
  target: string,
  vaultRealPath: string,
  options: ManagedTreeNodeSafetyOptions = {}
): Promise<Stats | null> {
  const fileSystem = options.fileSystem ?? MANAGED_TREE_NODE_SAFETY_FILE_SYSTEM;
  const allowMissing = options.allowMissing ?? false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let stat: Stats;
    try {
      stat = await fileSystem.lstat(target);
    } catch (error) {
      if (allowMissing && isFileSystemErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new PersonalMemoryAccessError("unsafe_path", `Managed Memory path must not be a symlink: ${target}`);
    }
    let targetRealPath: string;
    try {
      targetRealPath = await fileSystem.realpath(target);
    } catch (error) {
      if (!isFileSystemErrorCode(error, "ENOENT")) throw error;
      try {
        const replacement = await fileSystem.lstat(target);
        if (replacement.isSymbolicLink()) {
          throw new PersonalMemoryAccessError(
            "unsafe_path",
            `Managed Memory path must not be a symlink: ${target}`
          );
        }
      } catch (recheckError) {
        if (isFileSystemErrorCode(recheckError, "ENOENT")) {
          if (allowMissing) return null;
          throw error;
        }
        throw recheckError;
      }
      if (attempt === 0) continue;
      throw error;
    }
    const relative = path.relative(vaultRealPath, targetRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PersonalMemoryAccessError("unsafe_path", "Managed Memory realpath escapes the active Vault");
    }
    return stat;
  }
  throw new PersonalMemoryAccessError("unsafe_path", "Managed Memory path changed during safety validation");
}

function isFileSystemErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function writeIfMissing(target: string, content: string): Promise<void> {
  if (!(await pathExists(target))) await atomicWrite(target, content);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readTextOrEmpty(target: string): Promise<string> {
  return await pathExists(target) ? await readFile(target, "utf8") : "";
}

async function readBounded(target: string, maxChars: number, name: string): Promise<string> {
  const text = await readFile(target, "utf8");
  if (text.length > maxChars || hasDisallowedControlCharacters(text)) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} is too large or contains control characters`);
  }
  return text;
}

async function readUtf8Bounded(target: string, maxBytes: number, name: string): Promise<string> {
  const text = await readFile(target, "utf8");
  const bytes = utf8Bytes(text);
  if (bytes > maxBytes || hasDisallowedControlCharacters(text)) {
    throw new PersonalMemoryAccessError(
      "invalid_request",
      `${name} exceeds ${maxBytes} UTF-8 bytes or contains control characters`
    );
  }
  return text;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

async function readJsonOrNull<T>(target: string): Promise<T | null> {
  if (!(await pathExists(target))) return null;
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return null;
  }
}

function hasDisallowedControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    ) return true;
  }
  return false;
}

function isArrayValue(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function listFilesRecursively(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(target);
    }
  };
  await visit(root);
  return output.sort(compareText);
}
