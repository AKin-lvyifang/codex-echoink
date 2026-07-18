import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AgentBackendKind } from "../../agent/types";
import type { KnowledgeRunAttemptRecord } from "../../knowledge-base/types";

const JOURNAL_VERSION = 1;
const JOURNAL_DIRECTORY = "active-runs";
const STAGING_DIRECTORY = ".staging";
const ARCHIVE_DIRECTORY = ".archive";
const ENTRY_PREFIX = "entry-";
const ENTRY_WIDTH = 16;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 32;
const RUN_TOKEN_PATTERN = /^run-[a-f0-9]{24}$/;
const ENTRY_FILE_PATTERN = /^entry-([0-9]{16})\.json$/;
const UUID_PATTERN = "[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const STAGED_CREATE_PATTERN = new RegExp(
  `^\\.create-run-[a-f0-9]{24}-${UUID_PATTERN}$`
);
const STAGED_ENTRY_PATTERN = new RegExp(
  `^\\.run-[a-f0-9]{24}\\.entry-[0-9]{16}\\.json\\.${UUID_PATTERN}\\.tmp$`
);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const ACTIVE_MAINTENANCE_RUN_JOURNAL_VERSION = JOURNAL_VERSION;

export type ActiveMaintenanceRunMode = "maintain" | "reingest";
export type ActiveMaintenanceRunTerminalPhase =
  | "preflight"
  | "execution"
  | "verification";

export type ActiveMaintenanceRunJournalFaultPoint =
  | "after-staging-sync"
  | "after-publish";

export type ActiveMaintenanceRunJournalErrorCode =
  | "invalid_path"
  | "unsafe_entry"
  | "journal_exists"
  | "journal_missing"
  | "journal_corrupt"
  | "revision_conflict"
  | "invalid_transition"
  | "journal_blocked";

export class ActiveMaintenanceRunJournalError extends Error {
  constructor(
    public readonly code: ActiveMaintenanceRunJournalErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ActiveMaintenanceRunJournalError";
  }
}

/** Test-only abrupt-stop sentinel mirroring the workflow WAL fault injector. */
export class ActiveMaintenanceRunJournalSimulatedCrash extends Error {
  constructor(message = "simulated active maintenance journal crash") {
    super(message);
    this.name = "ActiveMaintenanceRunJournalSimulatedCrash";
  }
}

export interface ActiveMaintenanceRunJournalRecord {
  version: typeof JOURNAL_VERSION;
  workflowRunId: string;
  mode: ActiveMaintenanceRunMode;
  startedAt: number;
  selectedBackend: AgentBackendKind;
  attempts: KnowledgeRunAttemptRecord[];
  terminalPhase: ActiveMaintenanceRunTerminalPhase;
  revision: number;
  updatedAt: number;
  digest: string;
}

export interface ActiveMaintenanceRunJournalHandle {
  storageRootPath: string;
  journalRootPath: string;
  stagingRootPath: string;
  archiveRootPath: string;
  runToken: string;
  runRootPath: string;
  archivedRunRootPath: string;
  workflowRunId: string;
}

export interface LoadedActiveMaintenanceRunJournal {
  handle: ActiveMaintenanceRunJournalHandle;
  record: ActiveMaintenanceRunJournalRecord;
  /** Immutable append-only file that contains `record`. */
  recordPath: string;
}

export interface CreateActiveMaintenanceRunJournalInput {
  storageRootPath: string;
  workflowRunId: string;
  mode: ActiveMaintenanceRunMode;
  startedAt: number;
  selectedBackend: AgentBackendKind;
  attempts: readonly KnowledgeRunAttemptRecord[];
  terminalPhase: ActiveMaintenanceRunTerminalPhase;
  /** Test-only. Production callers must omit this hook. */
  faultInjector?: (
    point: ActiveMaintenanceRunJournalFaultPoint
  ) => void | Promise<void>;
}

export interface UpdateActiveMaintenanceRunJournalInput {
  expectedRevision: number;
  expectedDigest: string;
  attempts?: readonly KnowledgeRunAttemptRecord[];
  terminalPhase?: ActiveMaintenanceRunTerminalPhase;
  /** Test-only. Production callers must omit this hook. */
  faultInjector?: (
    point: ActiveMaintenanceRunJournalFaultPoint
  ) => void | Promise<void>;
}

export interface RemoveActiveMaintenanceRunJournalInput {
  expectedRevision: number;
  expectedDigest: string;
  /** Test-only. Production callers must omit this hook. */
  faultInjector?: (
    point: ActiveMaintenanceRunJournalFaultPoint
  ) => void | Promise<void>;
}

type ActiveMaintenanceRunJournalLocator =
  | ActiveMaintenanceRunJournalHandle
  | {
      storageRootPath: string;
      workflowRunId: string;
    };

interface ActiveMaintenanceRunJournalLayout {
  storageRootPath: string;
  journalRootPath: string;
  stagingRootPath: string;
  archiveRootPath: string;
}

interface SafeFileIdentity {
  dev: number;
  ino: number;
}

interface ActiveMaintenanceRunRemovalMarker {
  version: typeof JOURNAL_VERSION;
  kind: "removed";
  workflowRunId: string;
  revision: number;
  previousRevision: number;
  previousDigest: string;
  removedAt: number;
  digest: string;
}

interface JournalChain {
  handle: ActiveMaintenanceRunJournalHandle;
  current: LoadedActiveMaintenanceRunJournal;
  removed: ActiveMaintenanceRunRemovalMarker | null;
}

const PHASE_ORDER: ActiveMaintenanceRunTerminalPhase[] = [
  "preflight",
  "execution",
  "verification"
];

export function activeMaintenanceRunJournalRoot(
  storageRootPath: string
): string {
  return path.join(path.resolve(storageRootPath), JOURNAL_DIRECTORY);
}

/**
 * Creates revision zero in an unpublished staging directory, then atomically
 * renames the complete directory into the active namespace.
 */
export async function createActiveMaintenanceRunJournal(
  input: CreateActiveMaintenanceRunJournalInput
): Promise<LoadedActiveMaintenanceRunJournal> {
  const layout = await resolveJournalLayout(input.storageRootPath, true);
  if (!layout) throw journalMissing("active maintenance journal root 未创建");
  const handle = journalHandle(layout, input.workflowRunId);
  await assertWorkflowTokenIsUnused(handle);
  const record = withRecordDigest({
    version: JOURNAL_VERSION,
    workflowRunId: handle.workflowRunId,
    mode: input.mode,
    startedAt: input.startedAt,
    selectedBackend: input.selectedBackend,
    attempts: cloneAttempts(input.attempts),
    terminalPhase: input.terminalPhase,
    revision: 0,
    updatedAt: Math.max(Date.now(), input.startedAt)
  });
  assertValidRecord(record);

  const stagedRunRootPath = path.join(
    handle.stagingRootPath,
    `.create-${handle.runToken}-${randomUUID()}`
  );
  await fsp.mkdir(stagedRunRootPath, { mode: 0o700 });
  const stagedEntryPath = path.join(stagedRunRootPath, entryFileName(0));
  try {
    await writeNewFileDurably(stagedEntryPath, recordBytes(record));
    await syncDirectory(stagedRunRootPath);
    await syncDirectory(handle.stagingRootPath);
    await input.faultInjector?.("after-staging-sync");
    await assertWorkflowTokenIsUnused(handle);
    try {
      await fsp.rename(stagedRunRootPath, handle.runRootPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new ActiveMaintenanceRunJournalError(
          "journal_exists",
          `active maintenance journal 已存在：${handle.workflowRunId}`
        );
      }
      throw error;
    }
    await syncDirectory(handle.journalRootPath);
    await input.faultInjector?.("after-publish");
    const loaded = await loadJournalChain(handle);
    if (loaded.removed || loaded.current.record.digest !== record.digest) {
      throw journalCorrupt("active maintenance journal create readback 不一致");
    }
    return loaded.current;
  } catch (error) {
    if (error instanceof ActiveMaintenanceRunJournalSimulatedCrash) throw error;
    await removeSafeTree(stagedRunRootPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Appends exactly revision N+1 with a no-clobber hard-link publish. Competing
 * writers for the same expected revision target the same immutable filename;
 * only one can win and no stale writer can overwrite a newer record.
 */
export async function updateActiveMaintenanceRunJournal(
  locator: ActiveMaintenanceRunJournalLocator,
  input: UpdateActiveMaintenanceRunJournalInput
): Promise<LoadedActiveMaintenanceRunJournal> {
  const handle = await resolveJournalHandle(locator, false);
  const chain = await loadJournalChain(handle);
  if (chain.removed) throw journalMissing("active maintenance journal 已移除");
  assertExpectedRevision(chain.current.record, input);
  const attempts = input.attempts === undefined
    ? cloneAttempts(chain.current.record.attempts)
    : cloneAttempts(input.attempts);
  const terminalPhase = input.terminalPhase ?? chain.current.record.terminalPhase;
  assertMonotonicTransition(chain.current.record, attempts, terminalPhase);
  const record = withRecordDigest({
    version: JOURNAL_VERSION,
    workflowRunId: chain.current.record.workflowRunId,
    mode: chain.current.record.mode,
    startedAt: chain.current.record.startedAt,
    selectedBackend: chain.current.record.selectedBackend,
    attempts,
    terminalPhase,
    revision: chain.current.record.revision + 1,
    updatedAt: Math.max(Date.now(), chain.current.record.updatedAt + 1)
  });
  assertValidRecord(record);
  await publishAppendOnlyEntry(handle, record.revision, recordBytes(record), {
    faultInjector: input.faultInjector
  });
  const readback = await loadJournalChain(handle);
  if (readback.removed) throw journalMissing("active maintenance journal 已并发移除");
  if (
    readback.current.record.revision !== record.revision
    || readback.current.record.digest !== record.digest
  ) {
    throw new ActiveMaintenanceRunJournalError(
      "revision_conflict",
      "active maintenance journal append winner 与当前写入不一致"
    );
  }
  return readback.current;
}

export async function loadActiveMaintenanceRunJournal(
  locator: ActiveMaintenanceRunJournalLocator
): Promise<LoadedActiveMaintenanceRunJournal> {
  const handle = await resolveJournalHandle(locator, false);
  const chain = await loadJournalChain(handle);
  if (chain.removed) throw journalMissing("active maintenance journal 已移除");
  return chain.current;
}

/**
 * Lists only trusted active journals. Unknown or symlink entries in the active
 * namespace fail closed; archived terminal journals are outside this recovery
 * set and cannot be reused by `create`.
 */
export async function listActiveMaintenanceRunJournals(
  storageRootPath: string
): Promise<LoadedActiveMaintenanceRunJournal[]> {
  const layout = await resolveJournalLayout(storageRootPath, false);
  if (!layout) return [];
  const entries = await fsp.readdir(layout.journalRootPath, { withFileTypes: true });
  await assertSafeInternalNamespaces(layout);
  const loaded: LoadedActiveMaintenanceRunJournal[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === STAGING_DIRECTORY || entry.name === ARCHIVE_DIRECTORY) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new ActiveMaintenanceRunJournalError(
          "unsafe_entry",
          `active maintenance journal 内部目录不安全：${entry.name}`
        );
      }
      continue;
    }
    if (
      !RUN_TOKEN_PATTERN.test(entry.name)
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) {
      throw new ActiveMaintenanceRunJournalError(
        "unsafe_entry",
        `active maintenance journal 含不安全目录项：${entry.name}`
      );
    }
    const unresolved = journalHandleForToken(layout, entry.name);
    let chain: JournalChain;
    try {
      chain = await loadJournalChain(unresolved);
    } catch (error) {
      if (isNotFound(error) || isJournalMissingError(error)) continue;
      throw error;
    }
    if (!chain.removed) loaded.push(chain.current);
  }
  return loaded.sort((left, right) => (
    left.record.startedAt - right.record.startedAt
    || left.record.workflowRunId.localeCompare(right.record.workflowRunId)
  ));
}

/**
 * Removal is itself append-only: it first wins the next revision slot with a
 * digest-bound tombstone, then moves the complete run directory to `.archive`.
 * A racing update can therefore win or lose, but can never be deleted unseen.
 */
export async function removeActiveMaintenanceRunJournal(
  locator: ActiveMaintenanceRunJournalLocator,
  input: RemoveActiveMaintenanceRunJournalInput
): Promise<boolean> {
  const handle = await resolveJournalHandle(locator, false);
  const activeStat = await lstatOrNull(handle.runRootPath);
  if (!activeStat) {
    await assertArchivedRunSafeOrMissing(handle);
    return false;
  }
  assertSafeDirectoryStat(activeStat, "active maintenance run root");
  let chain = await loadJournalChain(handle);
  if (chain.removed) {
    await archiveRemovedRun(handle);
    return false;
  }
  assertExpectedRevision(chain.current.record, input);
  const removedAt = Math.max(Date.now(), chain.current.record.updatedAt + 1);
  const marker = withRemovalDigest({
    version: JOURNAL_VERSION,
    kind: "removed",
    workflowRunId: chain.current.record.workflowRunId,
    revision: chain.current.record.revision + 1,
    previousRevision: chain.current.record.revision,
    previousDigest: chain.current.record.digest,
    removedAt
  });
  try {
    await publishAppendOnlyEntry(
      handle,
      marker.revision,
      recordBytes(marker),
      { faultInjector: input.faultInjector }
    );
  } catch (error) {
    if (!(error instanceof ActiveMaintenanceRunJournalError)
      || error.code !== "revision_conflict") {
      throw error;
    }
    chain = await loadJournalChain(handle);
    if (!chain.removed) {
      assertExpectedRevision(chain.current.record, input);
      throw error;
    }
  }
  const confirmed = await loadJournalChain(handle);
  if (
    !confirmed.removed
    || confirmed.removed.previousRevision !== input.expectedRevision
    || confirmed.removed.previousDigest !== input.expectedDigest
  ) {
    throw new ActiveMaintenanceRunJournalError(
      "revision_conflict",
      "active maintenance journal remove tombstone CAS 不匹配"
    );
  }
  await archiveRemovedRun(handle);
  return true;
}

async function resolveJournalHandle(
  locator: ActiveMaintenanceRunJournalLocator,
  createLayout: boolean
): Promise<ActiveMaintenanceRunJournalHandle> {
  const layout = await resolveJournalLayout(locator.storageRootPath, createLayout);
  if (!layout) throw journalMissing("active maintenance journal root 不存在");
  const expected = journalHandle(layout, locator.workflowRunId);
  if (isFullHandle(locator)) {
    for (const key of [
      "storageRootPath",
      "journalRootPath",
      "stagingRootPath",
      "archiveRootPath",
      "runRootPath",
      "archivedRunRootPath"
    ] as const) {
      if (path.resolve(locator[key]) !== path.resolve(expected[key])) {
        throw new ActiveMaintenanceRunJournalError(
          "invalid_path",
          `active maintenance journal handle 不一致：${key}`
        );
      }
    }
    if (locator.runToken !== expected.runToken) {
      throw new ActiveMaintenanceRunJournalError(
        "invalid_path",
        "active maintenance journal handle runToken 不一致"
      );
    }
  }
  return expected;
}

async function resolveJournalLayout(
  storageRootPathInput: string,
  create: boolean
): Promise<ActiveMaintenanceRunJournalLayout | null> {
  const storageRootPath = await assertPlainDirectoryRoot(
    storageRootPathInput,
    "maintenance storage root"
  );
  const journalRootPath = await ensurePlainChildDirectory(
    storageRootPath,
    JOURNAL_DIRECTORY,
    create
  );
  if (!journalRootPath) return null;
  const stagingRootPath = await ensurePlainChildDirectory(
    journalRootPath,
    STAGING_DIRECTORY,
    create
  );
  const archiveRootPath = await ensurePlainChildDirectory(
    journalRootPath,
    ARCHIVE_DIRECTORY,
    create
  );
  if (!stagingRootPath || !archiveRootPath) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      "active maintenance journal 缺少内部安全目录"
    );
  }
  return { storageRootPath, journalRootPath, stagingRootPath, archiveRootPath };
}

function journalHandle(
  layout: ActiveMaintenanceRunJournalLayout,
  workflowRunIdInput: string
): ActiveMaintenanceRunJournalHandle {
  const workflowRunId = requireSafeText(
    workflowRunIdInput,
    "workflowRunId",
    512,
    true
  );
  return journalHandleForToken(
    layout,
    runTokenForWorkflow(workflowRunId),
    workflowRunId
  );
}

function journalHandleForToken(
  layout: ActiveMaintenanceRunJournalLayout,
  runToken: string,
  workflowRunId = `unresolved:${runToken}`
): ActiveMaintenanceRunJournalHandle {
  if (!RUN_TOKEN_PATTERN.test(runToken)) {
    throw new ActiveMaintenanceRunJournalError(
      "invalid_path",
      `active maintenance journal run token 非法：${runToken}`
    );
  }
  return {
    ...layout,
    runToken,
    runRootPath: path.join(layout.journalRootPath, runToken),
    archivedRunRootPath: path.join(layout.archiveRootPath, runToken),
    workflowRunId
  };
}

async function loadJournalChain(
  requestedHandle: ActiveMaintenanceRunJournalHandle
): Promise<JournalChain> {
  const runStat = await lstatOrNull(requestedHandle.runRootPath);
  if (!runStat) throw journalMissing("active maintenance run root 不存在");
  assertSafeDirectoryStat(runStat, "active maintenance run root");
  const entries = await fsp.readdir(requestedHandle.runRootPath, { withFileTypes: true });
  if (!entries.length) throw journalCorrupt("active maintenance run 缺少 revision entry");
  const ordered = entries.map((entry) => {
    const match = ENTRY_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new ActiveMaintenanceRunJournalError(
        "unsafe_entry",
        `active maintenance run 含不安全 entry：${entry.name}`
      );
    }
    const revision = Number(match[1]);
    if (!Number.isSafeInteger(revision)) throw journalCorrupt(`entry revision 非法：${entry.name}`);
    return { name: entry.name, revision };
  }).sort((left, right) => left.revision - right.revision);

  let current: LoadedActiveMaintenanceRunJournal | null = null;
  let removed: ActiveMaintenanceRunRemovalMarker | null = null;
  let resolvedHandle = requestedHandle;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (entry.revision !== index || entry.name !== entryFileName(index)) {
      throw journalCorrupt("active maintenance journal revision 不连续");
    }
    const entryPath = path.join(requestedHandle.runRootPath, entry.name);
    const value = await readJsonEntry(entryPath);
    if (isRemovalCandidate(value)) {
      const marker = assertValidRemovalMarker(value, entry.revision);
      if (!current || index !== ordered.length - 1) {
        throw journalCorrupt("remove tombstone 缺少前序或不是最后 entry");
      }
      if (
        marker.workflowRunId !== current.record.workflowRunId
        || marker.previousRevision !== current.record.revision
        || marker.previousDigest !== current.record.digest
      ) {
        throw journalCorrupt("remove tombstone 与前序 record 不匹配");
      }
      removed = marker;
      continue;
    }
    assertValidRecord(value);
    if (removed) throw journalCorrupt("remove tombstone 后出现新 revision");
    if (value.revision !== entry.revision) {
      throw journalCorrupt("record revision 与 entry 文件名不匹配");
    }
    if (runTokenForWorkflow(value.workflowRunId) !== requestedHandle.runToken) {
      throw journalCorrupt("workflowRunId 与 run token 不匹配");
    }
    if (requestedHandle.workflowRunId.startsWith("unresolved:")) {
      resolvedHandle = journalHandle(
        {
          storageRootPath: requestedHandle.storageRootPath,
          journalRootPath: requestedHandle.journalRootPath,
          stagingRootPath: requestedHandle.stagingRootPath,
          archiveRootPath: requestedHandle.archiveRootPath
        },
        value.workflowRunId
      );
    } else if (value.workflowRunId !== requestedHandle.workflowRunId) {
      throw journalCorrupt("workflowRunId 与 journal handle 不匹配");
    }
    if (current) assertRecordFollows(current.record, value);
    current = { handle: resolvedHandle, record: value, recordPath: entryPath };
  }
  if (!current) throw journalCorrupt("active maintenance run 缺少 record");
  return { handle: resolvedHandle, current, removed };
}

async function publishAppendOnlyEntry(
  handle: ActiveMaintenanceRunJournalHandle,
  revision: number,
  content: Buffer,
  options: {
    faultInjector?: (
      point: ActiveMaintenanceRunJournalFaultPoint
    ) => void | Promise<void>;
  }
): Promise<void> {
  const runStat = await fsp.lstat(handle.runRootPath);
  assertSafeDirectoryStat(runStat, "active maintenance run root");
  const targetPath = path.join(handle.runRootPath, entryFileName(revision));
  const stagingPath = path.join(
    handle.stagingRootPath,
    `.${handle.runToken}.${entryFileName(revision)}.${randomUUID()}.tmp`
  );
  let stagedIdentity: SafeFileIdentity | null = null;
  try {
    stagedIdentity = await writeNewFileDurably(stagingPath, content);
    await syncDirectory(handle.stagingRootPath);
    await options.faultInjector?.("after-staging-sync");
    try {
      await fsp.link(stagingPath, targetPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new ActiveMaintenanceRunJournalError(
          "revision_conflict",
          `revision ${revision} 已由另一个 writer 发布`
        );
      }
      throw error;
    }
    await syncDirectory(handle.runRootPath);
    await options.faultInjector?.("after-publish");
    await unlinkIfIdentityMatches(stagingPath, stagedIdentity, [1, 2]);
    await syncDirectory(handle.stagingRootPath);
  } catch (error) {
    if (error instanceof ActiveMaintenanceRunJournalSimulatedCrash) throw error;
    if (stagedIdentity) {
      await unlinkIfIdentityMatches(stagingPath, stagedIdentity, [1, 2])
        .catch(() => undefined);
      await syncDirectory(handle.stagingRootPath).catch(() => undefined);
    }
    throw error;
  }
}

async function archiveRemovedRun(
  handle: ActiveMaintenanceRunJournalHandle
): Promise<void> {
  const active = await lstatOrNull(handle.runRootPath);
  if (!active) {
    await assertArchivedRunSafeOrMissing(handle);
    return;
  }
  assertSafeDirectoryStat(active, "removed active maintenance run");
  const chain = await loadJournalChain(handle);
  if (!chain.removed) {
    throw new ActiveMaintenanceRunJournalError(
      "invalid_transition",
      "没有 remove tombstone，拒绝 archive active run"
    );
  }
  const archived = await lstatOrNull(handle.archivedRunRootPath);
  if (archived) {
    assertSafeDirectoryStat(archived, "archived maintenance run");
    throw new ActiveMaintenanceRunJournalError(
      "journal_exists",
      `archive token 已存在：${handle.runToken}`
    );
  }
  try {
    await fsp.rename(handle.runRootPath, handle.archivedRunRootPath);
  } catch (error) {
    if (isNotFound(error)) {
      await assertArchivedRunSafeOrMissing(handle);
      return;
    }
    throw error;
  }
  await syncDirectory(handle.journalRootPath);
  await syncDirectory(handle.archiveRootPath);
  const moved = await fsp.lstat(handle.archivedRunRootPath);
  if (!sameIdentity(active, moved)) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      "archive 后 run directory identity 不匹配"
    );
  }
}

async function assertWorkflowTokenIsUnused(
  handle: ActiveMaintenanceRunJournalHandle
): Promise<void> {
  for (const candidate of [handle.runRootPath, handle.archivedRunRootPath]) {
    const stat = await lstatOrNull(candidate);
    if (!stat) continue;
    assertSafeDirectoryStat(stat, "active maintenance workflow token");
    throw new ActiveMaintenanceRunJournalError(
      "journal_exists",
      `workflowRunId 已存在或已归档：${handle.workflowRunId}`
    );
  }
}

async function assertArchivedRunSafeOrMissing(
  handle: ActiveMaintenanceRunJournalHandle
): Promise<void> {
  const archived = await lstatOrNull(handle.archivedRunRootPath);
  if (archived) assertSafeDirectoryStat(archived, "archived maintenance run");
}

async function readJsonEntry(absolutePath: string): Promise<unknown> {
  const content = await readIndependentRegularFile(
    absolutePath,
    "active maintenance journal entry",
    MAX_JOURNAL_BYTES,
    [1, 2]
  );
  try {
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch (error) {
    throw journalCorrupt(`journal entry 无法解析：${errorMessage(error)}`);
  }
}

async function readIndependentRegularFile(
  absolutePath: string,
  label: string,
  maxBytes: number,
  allowedLinkCounts: readonly number[] = [1]
): Promise<Buffer> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      absolutePath,
      fsConstants.O_RDONLY | noFollowFlag()
    );
  } catch (error) {
    if (isNotFound(error)) throw journalMissing(`${label} 不存在`);
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      `${label} 无法安全打开：${errorMessage(error)}`
    );
  }
  try {
    const before = await handle.stat();
    assertSafeRegularStat(before, label, allowedLinkCounts);
    if (before.size > maxBytes) {
      throw new ActiveMaintenanceRunJournalError(
        "unsafe_entry",
        `${label} 超过安全读取上限`
      );
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!sameOpenFileVersion(before, after) || content.byteLength !== before.size) {
      throw new ActiveMaintenanceRunJournalError(
        "unsafe_entry",
        `${label} 在读取时发生变化`
      );
    }
    return content;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeNewFileDurably(
  absolutePath: string,
  content: Buffer
): Promise<SafeFileIdentity> {
  if (content.byteLength > MAX_JOURNAL_BYTES) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      "active maintenance journal 超过安全写入上限"
    );
  }
  const output = await fsp.open(
    absolutePath,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | noFollowFlag(),
    0o600
  );
  try {
    await output.writeFile(content);
    await output.chmod(0o600);
    await output.sync();
    const stat = await output.stat();
    assertSafeRegularStat(stat, "new journal entry");
    return { dev: Number(stat.dev), ino: Number(stat.ino) };
  } finally {
    await output.close().catch(() => undefined);
  }
}

function recordBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function entryFileName(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw journalCorrupt(`entry revision 非法：${revision}`);
  }
  const digits = String(revision);
  if (digits.length > ENTRY_WIDTH) {
    throw journalCorrupt(`entry revision 超出上限：${revision}`);
  }
  return `${ENTRY_PREFIX}${digits.padStart(ENTRY_WIDTH, "0")}.json`;
}

function runTokenForWorkflow(workflowRunId: string): string {
  return `run-${createHash("sha256").update(workflowRunId).digest("hex").slice(0, 24)}`;
}

function withRecordDigest(
  record: Omit<ActiveMaintenanceRunJournalRecord, "digest">
): ActiveMaintenanceRunJournalRecord {
  return { ...record, digest: digestJson(record) };
}

function withRemovalDigest(
  marker: Omit<ActiveMaintenanceRunRemovalMarker, "digest">
): ActiveMaintenanceRunRemovalMarker {
  return { ...marker, digest: digestJson(marker) };
}

function assertValidRecord(
  value: unknown
): asserts value is ActiveMaintenanceRunJournalRecord {
  if (!isPlainRecord(value)) throw journalCorrupt("journal record 不是对象");
  assertExactKeys(value, [
    "version",
    "workflowRunId",
    "mode",
    "startedAt",
    "selectedBackend",
    "attempts",
    "terminalPhase",
    "revision",
    "updatedAt",
    "digest"
  ], "journal record");
  if (value.version !== JOURNAL_VERSION) throw journalCorrupt("journal version 非法");
  requireSafeText(value.workflowRunId, "workflowRunId", 512, true);
  if (value.mode !== "maintain" && value.mode !== "reingest") {
    throw journalCorrupt("journal mode 非法");
  }
  assertSafeTimestamp(value.startedAt, "startedAt");
  if (!isAgentBackendKind(value.selectedBackend)) {
    throw journalCorrupt("selectedBackend 非法");
  }
  if (!Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS) {
    throw journalCorrupt("attempts 非法或过多");
  }
  value.attempts.forEach((attempt, index) => assertValidAttempt(attempt, index));
  assertAttemptSequence(value.attempts, value.selectedBackend);
  if (!isTerminalPhase(value.terminalPhase)) {
    throw journalCorrupt("terminalPhase 非法");
  }
  if (
    typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
  ) {
    throw journalCorrupt("revision 非法");
  }
  assertSafeTimestamp(value.updatedAt, "updatedAt");
  if (value.updatedAt < value.startedAt) {
    throw journalCorrupt("updatedAt 早于 startedAt");
  }
  if (typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest)) {
    throw journalCorrupt("digest 非法");
  }
  const { digest, ...withoutDigest } = value;
  if (digest !== digestJson(withoutDigest)) {
    throw journalCorrupt("digest 与 journal 内容不匹配");
  }
}

function assertValidRemovalMarker(
  value: unknown,
  expectedRevision: number
): ActiveMaintenanceRunRemovalMarker {
  if (!isPlainRecord(value)) throw journalCorrupt("remove tombstone 不是对象");
  assertExactKeys(value, [
    "version",
    "kind",
    "workflowRunId",
    "revision",
    "previousRevision",
    "previousDigest",
    "removedAt",
    "digest"
  ], "remove tombstone");
  if (value.version !== JOURNAL_VERSION || value.kind !== "removed") {
    throw journalCorrupt("remove tombstone version/kind 非法");
  }
  requireSafeText(value.workflowRunId, "remove.workflowRunId", 512, true);
  if (
    typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
  ) throw journalCorrupt("remove.revision 非法");
  if (
    typeof value.previousRevision !== "number"
    || !Number.isSafeInteger(value.previousRevision)
    || value.previousRevision < 0
  ) throw journalCorrupt("remove.previousRevision 非法");
  if (
    value.revision !== expectedRevision
    || value.previousRevision + 1 !== value.revision
  ) {
    throw journalCorrupt("remove tombstone revision 链非法");
  }
  if (typeof value.previousDigest !== "string" || !SHA256_PATTERN.test(value.previousDigest)) {
    throw journalCorrupt("remove.previousDigest 非法");
  }
  assertSafeTimestamp(value.removedAt, "remove.removedAt");
  if (typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest)) {
    throw journalCorrupt("remove.digest 非法");
  }
  const { digest, ...withoutDigest } = value;
  if (digest !== digestJson(withoutDigest)) {
    throw journalCorrupt("remove tombstone digest 不匹配");
  }
  return value as unknown as ActiveMaintenanceRunRemovalMarker;
}

function assertRecordFollows(
  previous: ActiveMaintenanceRunJournalRecord,
  current: ActiveMaintenanceRunJournalRecord
): void {
  if (
    current.revision !== previous.revision + 1
    || current.workflowRunId !== previous.workflowRunId
    || current.mode !== previous.mode
    || current.startedAt !== previous.startedAt
    || current.selectedBackend !== previous.selectedBackend
    || current.updatedAt <= previous.updatedAt
  ) {
    throw journalCorrupt("append-only record immutable fields 或 revision 链不匹配");
  }
  try {
    assertMonotonicTransition(
      previous,
      current.attempts,
      current.terminalPhase
    );
  } catch (error) {
    if (error instanceof ActiveMaintenanceRunJournalError) {
      throw journalCorrupt(`append-only record 非单调：${error.message}`);
    }
    throw error;
  }
}

function assertExpectedRevision(
  current: ActiveMaintenanceRunJournalRecord,
  expected: RemoveActiveMaintenanceRunJournalInput
): void {
  if (
    !Number.isSafeInteger(expected.expectedRevision)
    || expected.expectedRevision < 0
    || typeof expected.expectedDigest !== "string"
    || !SHA256_PATTERN.test(expected.expectedDigest)
    || current.revision !== expected.expectedRevision
    || current.digest !== expected.expectedDigest
  ) {
    throw new ActiveMaintenanceRunJournalError(
      "revision_conflict",
      `active maintenance journal CAS 冲突：当前 revision=${current.revision}`
    );
  }
}

function assertMonotonicTransition(
  previous: ActiveMaintenanceRunJournalRecord,
  attempts: readonly KnowledgeRunAttemptRecord[],
  terminalPhase: ActiveMaintenanceRunTerminalPhase
): void {
  if (
    PHASE_ORDER.indexOf(terminalPhase)
    < PHASE_ORDER.indexOf(previous.terminalPhase)
  ) {
    throw invalidTransition(
      `terminalPhase 不得回退：${previous.terminalPhase} -> ${terminalPhase}`
    );
  }
  if (attempts.length < previous.attempts.length) {
    throw invalidTransition("attempts 不得删除已有 attempt");
  }
  if (
    attempts.length > previous.attempts.length
    && previous.terminalPhase === "verification"
  ) {
    throw invalidTransition("verification 后不得新增 attempt");
  }
  for (let index = 0; index < previous.attempts.length; index += 1) {
    const before = previous.attempts[index];
    const after = attempts[index];
    if (
      !after
      || before.attemptId !== after.attemptId
      || before.ordinal !== after.ordinal
      || before.backend !== after.backend
    ) {
      throw invalidTransition(`attempts[${index}] identity 不得改写`);
    }
    assertDeepAppendOnly(before, after, `attempts[${index}]`);
  }
  assertAttemptSequence(attempts, previous.selectedBackend);
}

function assertDeepAppendOnly(
  before: unknown,
  after: unknown,
  label: string
): void {
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length < before.length) {
      throw invalidTransition(`${label} array 不得缩短`);
    }
    before.forEach((value, index) => {
      assertDeepAppendOnly(value, after[index], `${label}[${index}]`);
    });
    return;
  }
  if (isPlainRecord(before)) {
    if (!isPlainRecord(after)) throw invalidTransition(`${label} 对象不得删除`);
    for (const [key, value] of Object.entries(before)) {
      if (!(key in after)) throw invalidTransition(`${label}.${key} 不得删除`);
      assertDeepAppendOnly(value, after[key], `${label}.${key}`);
    }
    return;
  }
  if (stableStringify(before) !== stableStringify(after)) {
    throw invalidTransition(`${label} 已有值不得改写`);
  }
}

function assertAttemptSequence(
  attempts: readonly KnowledgeRunAttemptRecord[],
  selectedBackend: AgentBackendKind
): void {
  const ids = new Set<string>();
  const backends = new Set<AgentBackendKind>();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (attempt.ordinal !== index + 1) {
      throw journalCorrupt("attempt ordinal 必须从 1 连续递增");
    }
    if (ids.has(attempt.attemptId) || backends.has(attempt.backend)) {
      throw journalCorrupt("attempts 含重复 attemptId 或 backend");
    }
    ids.add(attempt.attemptId);
    backends.add(attempt.backend);
    if (index === 0 && attempt.backend !== selectedBackend) {
      throw journalCorrupt("首个 attempt backend 与 selectedBackend 不一致");
    }
    if (index > 0) assertSafeFallbackPredecessor(attempts[index - 1], index - 1);
  }
}

function assertSafeFallbackPredecessor(
  previous: KnowledgeRunAttemptRecord,
  index: number
): void {
  if (
    !previous.terminal
    || (previous.terminal.status !== "failed" && previous.terminal.status !== "canceled")
    || !previous.failure?.failoverEligible
  ) {
    throw journalCorrupt(`attempts[${index}] 缺少安全 fallback 失败终态`);
  }
  if (
    (previous.submitted || previous.native)
    && previous.termination?.confirmedAt === undefined
  ) {
    throw journalCorrupt(`attempts[${index}] 缺少原生终止确认`);
  }
}

function assertValidAttempt(value: unknown, index: number): void {
  if (!isPlainRecord(value)) throw journalCorrupt(`attempts[${index}] 不是对象`);
  assertAllowedKeys(value, [
    "attemptId",
    "ordinal",
    "backend",
    "native",
    "submitted",
    "terminal",
    "failure",
    "termination",
    "staging"
  ], `attempts[${index}]`);
  requireSafeText(value.attemptId, `attempts[${index}].attemptId`, 512, true);
  if (
    typeof value.ordinal !== "number"
    || !Number.isSafeInteger(value.ordinal)
    || value.ordinal < 1
  ) {
    throw journalCorrupt(`attempts[${index}].ordinal 非法`);
  }
  if (!isAgentBackendKind(value.backend)) {
    throw journalCorrupt(`attempts[${index}].backend 非法`);
  }
  if (value.native !== undefined) assertValidNative(value.native, index);
  if (value.submitted !== undefined) assertValidSubmitted(value.submitted, index);
  if (value.terminal !== undefined) assertValidTerminal(value.terminal, index);
  if (value.failure !== undefined) assertValidFailure(value.failure, index);
  if (value.termination !== undefined) assertValidTermination(value.termination, index);
  if (value.staging !== undefined) assertValidStaging(value.staging, index);
}

function assertValidNative(value: unknown, index: number): void {
  const label = `attempts[${index}].native`;
  assertPlainObjectWithAllowedKeys(value, ["id", "kind", "persistence"], label);
  requireSafeText(value.id, `${label}.id`, 2048, true);
  if (
    value.kind !== undefined
    && !["thread", "session", "run", "process"].includes(String(value.kind))
  ) {
    throw journalCorrupt(`${label}.kind 非法`);
  }
  if (
    value.persistence !== undefined
    && !["none", "process-local", "provider-persistent", "unknown"]
      .includes(String(value.persistence))
  ) {
    throw journalCorrupt(`${label}.persistence 非法`);
  }
}

function assertValidSubmitted(value: unknown, index: number): void {
  const label = `attempts[${index}].submitted`;
  assertPlainObjectWithExactKeys(value, ["at", "harnessRunId"], label);
  assertSafeTimestamp(value.at, `${label}.at`);
  requireSafeText(value.harnessRunId, `${label}.harnessRunId`, 2048, true);
}

function assertValidTerminal(value: unknown, index: number): void {
  const label = `attempts[${index}].terminal`;
  assertPlainObjectWithAllowedKeys(value, ["status", "at", "message"], label);
  for (const required of ["status", "at"] as const) {
    if (!(required in value)) throw journalCorrupt(`${label}.${required} 缺失`);
  }
  if (!["completed", "failed", "canceled"].includes(String(value.status))) {
    throw journalCorrupt(`${label}.status 非法`);
  }
  assertSafeTimestamp(value.at, `${label}.at`);
  if (value.message !== undefined) {
    requireSafeText(value.message, `${label}.message`, 32_000, false);
  }
}

function assertValidFailure(value: unknown, index: number): void {
  const label = `attempts[${index}].failure`;
  assertPlainObjectWithExactKeys(value, [
    "code",
    "at",
    "message",
    "phase",
    "retryable",
    "failoverEligible"
  ], label);
  requireSafeText(value.code, `${label}.code`, 256, true);
  assertSafeTimestamp(value.at, `${label}.at`);
  requireSafeText(value.message, `${label}.message`, 32_000, false);
  if (!["preflight", "execution", "verification", "commit", "cleanup"]
    .includes(String(value.phase))) {
    throw journalCorrupt(`${label}.phase 非法`);
  }
  if (typeof value.retryable !== "boolean" || typeof value.failoverEligible !== "boolean") {
    throw journalCorrupt(`${label} retry/failover 标记非法`);
  }
}

function assertValidTermination(value: unknown, index: number): void {
  const label = `attempts[${index}].termination`;
  assertPlainObjectWithAllowedKeys(value, [
    "requestedAt",
    "confirmedAt",
    "failedAt",
    "message"
  ], label);
  for (const field of ["requestedAt", "confirmedAt", "failedAt"] as const) {
    if (value[field] !== undefined) assertSafeTimestamp(value[field], `${label}.${field}`);
  }
  if (value.message !== undefined) {
    requireSafeText(value.message, `${label}.message`, 32_000, false);
  }
}

function assertValidStaging(value: unknown, index: number): void {
  const label = `attempts[${index}].staging`;
  assertPlainObjectWithAllowedKeys(value, [
    "path",
    "preparedAt",
    "promotedAt",
    "discardedAt",
    "failedAt",
    "message"
  ], label);
  for (const required of ["path", "preparedAt"] as const) {
    if (!(required in value)) throw journalCorrupt(`${label}.${required} 缺失`);
  }
  requireSafeText(value.path, `${label}.path`, 32_000, true);
  assertSafeTimestamp(value.preparedAt, `${label}.preparedAt`);
  for (const field of ["promotedAt", "discardedAt", "failedAt"] as const) {
    if (value[field] !== undefined) assertSafeTimestamp(value[field], `${label}.${field}`);
  }
  if (value.message !== undefined) {
    requireSafeText(value.message, `${label}.message`, 32_000, false);
  }
}

async function assertSafeInternalNamespaces(
  layout: ActiveMaintenanceRunJournalLayout
): Promise<void> {
  for (const entry of await fsp.readdir(layout.stagingRootPath, { withFileTypes: true })) {
    const entryPath = path.join(layout.stagingRootPath, entry.name);
    if (STAGED_CREATE_PATTERN.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new ActiveMaintenanceRunJournalError(
          "unsafe_entry",
          `journal staging create 项不安全：${entry.name}`
        );
      }
      await assertSafeStagedCreateDirectory(entryPath);
      continue;
    }
    if (STAGED_ENTRY_PATTERN.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new ActiveMaintenanceRunJournalError(
          "unsafe_entry",
          `journal staging entry 项不安全：${entry.name}`
        );
      }
      const stat = await fsp.lstat(entryPath);
      assertSafeRegularStat(stat, "journal staging entry", [1, 2]);
      continue;
    }
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      `journal staging 含未知项：${entry.name}`
    );
  }
  for (const entry of await fsp.readdir(layout.archiveRootPath, { withFileTypes: true })) {
    if (
      !RUN_TOKEN_PATTERN.test(entry.name)
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) {
      throw new ActiveMaintenanceRunJournalError(
        "unsafe_entry",
        `journal archive 含不安全项：${entry.name}`
      );
    }
    await assertSafeArchivedDirectory(
      path.join(layout.archiveRootPath, entry.name)
    );
  }
}

async function assertSafeStagedCreateDirectory(
  directoryPath: string
): Promise<void> {
  const stat = await fsp.lstat(directoryPath);
  assertSafeDirectoryStat(stat, "staged create directory");
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  if (entries.length > 1) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      "staged create directory 含多个 entry"
    );
  }
  for (const entry of entries) {
    if (
      entry.name !== entryFileName(0)
      || !entry.isFile()
      || entry.isSymbolicLink()
    ) {
      throw new ActiveMaintenanceRunJournalError(
        "unsafe_entry",
        `staged create directory 含不安全项：${entry.name}`
      );
    }
    const file = await fsp.lstat(path.join(directoryPath, entry.name));
    assertSafeRegularStat(file, "staged create entry", [1, 2]);
  }
}

async function assertSafeArchivedDirectory(
  directoryPath: string
): Promise<void> {
  const stat = await fsp.lstat(directoryPath);
  assertSafeDirectoryStat(stat, "archived run directory");
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  if (!entries.length) throw journalCorrupt("archived run directory 为空");
  for (const entry of entries) {
    if (
      !ENTRY_FILE_PATTERN.test(entry.name)
      || !entry.isFile()
      || entry.isSymbolicLink()
    ) {
      throw new ActiveMaintenanceRunJournalError(
        "unsafe_entry",
        `archived run 含不安全 entry：${entry.name}`
      );
    }
    const file = await fsp.lstat(path.join(directoryPath, entry.name));
    assertSafeRegularStat(file, "archived journal entry", [1, 2]);
  }
}

async function assertPlainDirectoryRoot(
  absolutePathInput: string,
  label: string
): Promise<string> {
  if (
    typeof absolutePathInput !== "string"
    || !absolutePathInput.trim()
    || absolutePathInput.includes("\0")
  ) {
    throw new ActiveMaintenanceRunJournalError("invalid_path", `${label} 路径非法`);
  }
  const absolutePath = path.resolve(absolutePathInput);
  const before = await lstatOrNull(absolutePath);
  if (!before) throw journalMissing(`${label} 不存在`);
  assertSafeDirectoryStat(before, label);
  const canonicalPath = path.resolve(await fsp.realpath(absolutePath));
  const after = await fsp.lstat(canonicalPath);
  if (!sameIdentity(before, after)) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      `${label} canonical identity 不一致`
    );
  }
  return canonicalPath;
}

async function ensurePlainChildDirectory(
  parentPath: string,
  childName: string,
  create: boolean
): Promise<string | null> {
  if (
    !childName
    || childName.includes(path.sep)
    || childName === "."
    || childName === ".."
  ) {
    throw new ActiveMaintenanceRunJournalError(
      "invalid_path",
      `内部目录名非法：${childName}`
    );
  }
  const parentBefore = await fsp.lstat(parentPath);
  assertSafeDirectoryStat(parentBefore, "内部目录父级");
  const childPath = path.join(parentPath, childName);
  let child = await lstatOrNull(childPath);
  if (!child && create) {
    try {
      await fsp.mkdir(childPath, { mode: 0o700 });
      await syncDirectory(parentPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    child = await lstatOrNull(childPath);
  }
  if (!child) return null;
  assertSafeDirectoryStat(child, `内部目录 ${childName}`);
  const parentAfter = await fsp.lstat(parentPath);
  if (!sameIdentity(parentBefore, parentAfter)) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      `内部目录父级 identity 发生变化：${parentPath}`
    );
  }
  const canonicalChild = path.resolve(await fsp.realpath(childPath));
  if (canonicalChild !== childPath) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      `内部目录经过 symlink：${childPath}`
    );
  }
  return canonicalChild;
}

async function unlinkIfIdentityMatches(
  absolutePath: string,
  expected: SafeFileIdentity,
  allowedLinkCounts: readonly number[] = [1]
): Promise<void> {
  const current = await lstatOrNull(absolutePath);
  if (!current) return;
  assertSafeRegularStat(current, "journal staging file", allowedLinkCounts);
  if (!sameIdentity(current, expected)) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      `拒绝删除 identity 不匹配的文件：${absolutePath}`
    );
  }
  await fsp.unlink(absolutePath);
}

async function removeSafeTree(absolutePath: string): Promise<void> {
  const root = await lstatOrNull(absolutePath);
  if (!root) return;
  assertSafeDirectoryStat(root, "staged journal tree");
  for (const entry of await fsp.readdir(absolutePath, { withFileTypes: true })) {
    const childPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removeSafeTree(childPath);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new ActiveMaintenanceRunJournalError(
        "unsafe_entry",
        `staged journal tree 含不安全项：${childPath}`
      );
    }
    const stat = await fsp.lstat(childPath);
    assertSafeRegularStat(stat, "staged journal file", [1, 2]);
    await fsp.unlink(childPath);
  }
  await fsp.rmdir(absolutePath);
}

function assertPlainObjectWithExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw journalCorrupt(`${label} 不是对象`);
  assertExactKeys(value, keys, label);
}

function assertPlainObjectWithAllowedKeys(
  value: unknown,
  keys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw journalCorrupt(`${label} 不是对象`);
  assertAllowedKeys(value, keys, label);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw journalCorrupt(`${label} 字段集合非法`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw journalCorrupt(`${label} 含未知字段`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRemovalCandidate(value: unknown): boolean {
  return isPlainRecord(value) && value.kind === "removed";
}

function requireSafeText(
  value: unknown,
  label: string,
  maxLength: number,
  nonEmpty: boolean
): string {
  if (
    typeof value !== "string"
    || value.length > maxLength
    || UNSAFE_CONTROL_CHARACTER.test(value)
    || (nonEmpty && (!value.trim() || value !== value.trim()))
  ) {
    throw journalCorrupt(`${label} 非法`);
  }
  return value;
}

function assertSafeTimestamp(
  value: unknown,
  label: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw journalCorrupt(`${label} 非法`);
  }
}

function isAgentBackendKind(value: unknown): value is AgentBackendKind {
  return value === "codex-cli" || value === "opencode" || value === "hermes";
}

function isTerminalPhase(value: unknown): value is ActiveMaintenanceRunTerminalPhase {
  return value === "preflight" || value === "execution" || value === "verification";
}

function invalidTransition(message: string): ActiveMaintenanceRunJournalError {
  return new ActiveMaintenanceRunJournalError("invalid_transition", message);
}

function journalCorrupt(message: string): ActiveMaintenanceRunJournalError {
  return new ActiveMaintenanceRunJournalError("journal_corrupt", message);
}

function journalMissing(message: string): ActiveMaintenanceRunJournalError {
  return new ActiveMaintenanceRunJournalError("journal_missing", message);
}

function isJournalMissingError(error: unknown): boolean {
  return error instanceof ActiveMaintenanceRunJournalError
    && error.code === "journal_missing";
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(stableStringify(value), "utf8"))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function cloneAttempts(
  attempts: readonly KnowledgeRunAttemptRecord[]
): KnowledgeRunAttemptRecord[] {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(attempts)) as unknown;
  } catch (error) {
    throw journalCorrupt(`attempts 无法序列化：${errorMessage(error)}`);
  }
  if (!Array.isArray(cloned)) throw journalCorrupt("attempts 不是数组");
  return cloned as KnowledgeRunAttemptRecord[];
}

function assertSafeDirectoryStat(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      `${label} 不是安全目录`
    );
  }
}

function assertSafeRegularStat(
  stat: Stats,
  label: string,
  allowedLinkCounts: readonly number[] = [1]
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !allowedLinkCounts.includes(stat.nlink)
  ) {
    throw new ActiveMaintenanceRunJournalError(
      "unsafe_entry",
      `${label} 不是独立普通文件`
    );
  }
}

function sameIdentity(left: Stats | SafeFileIdentity, right: Stats | SafeFileIdentity): boolean {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

function sameOpenFileVersion(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directory: fsp.FileHandle | undefined;
  try {
    directory = await fsp.open(directoryPath, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32"
      || !["EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")
    ) {
      throw error;
    }
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
  return await fsp.lstat(absolutePath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
}

function isFullHandle(
  locator: ActiveMaintenanceRunJournalLocator
): locator is ActiveMaintenanceRunJournalHandle {
  return "runRootPath" in locator;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? ""
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
