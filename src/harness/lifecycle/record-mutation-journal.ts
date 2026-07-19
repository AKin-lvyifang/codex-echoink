import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  assertDurableDirectoryStat,
  assertDurableRegularFileStat,
  DurableAppendOnlyCasError,
  durableAppendOnlyChainPath,
  durableLstatOrNull,
  publishDurableAppendOnlyChain,
  publishDurableAppendOnlyEntry,
  readDurableRegularFile,
  resolveDurableAppendOnlyLayout,
  type DurableAppendOnlyFaultPoint,
  type DurableAppendOnlyLayout
} from "../storage/durable-append-only-cas";
import {
  assertRecordMutationChainCompleteness,
  assertRecordMutationTransition,
  createPlannedRecordMutationRevision,
  parseRecordMutationRevision,
  RECORD_MUTATION_MAX_RECORD_BYTES,
  RECORD_MUTATION_MAX_REVISIONS,
  RecordMutationContractError,
  transitionRecordMutationRevision,
  type RecordMutationIntent,
  type RecordMutationRevision,
  type RecordMutationStep
} from "./record-mutation-contract";

const JOURNAL_DIRECTORY = "record-mutations";
const ENTRY_PREFIX = "entry-";
const ENTRY_WIDTH = 16;
const CHAIN_TOKEN_PATTERN = /^mutation-[a-f0-9]{24}$/;
const ENTRY_FILE_PATTERN = /^entry-([0-9]{16})\.json$/;
const UUID_PATTERN = "[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const STAGED_CREATE_PATTERN = new RegExp(
  `^\\.create-mutation-[a-f0-9]{24}-${UUID_PATTERN}$`
);
const STAGED_ENTRY_PATTERN = new RegExp(
  `^\\.mutation-[a-f0-9]{24}\\.entry-[0-9]{16}\\.json\\.${UUID_PATTERN}\\.tmp$`
);
const MAX_NAMESPACE_ENTRIES = 4_096;

export type RecordMutationJournalErrorCode =
  | "invalid_path"
  | "unsafe_entry"
  | "journal_exists"
  | "journal_missing"
  | "journal_corrupt"
  | "revision_conflict"
  | "invalid_transition"
  | "journal_blocked";

export class RecordMutationJournalError extends Error {
  constructor(
    public readonly code: RecordMutationJournalErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RecordMutationJournalError";
  }
}

export class RecordMutationJournalSimulatedCrash extends Error {
  constructor(message = "simulated record mutation journal crash") {
    super(message);
    this.name = "RecordMutationJournalSimulatedCrash";
  }
}

export type RecordMutationJournalFaultPoint = DurableAppendOnlyFaultPoint;

export interface RecordMutationJournalHandle {
  storageRootPath: string;
  journalRootPath: string;
  stagingRootPath: string;
  chainToken: string;
  chainRootPath: string;
  mutationId: string;
}

export interface LoadedRecordMutationJournal {
  handle: RecordMutationJournalHandle;
  record: RecordMutationRevision;
  recordPath: string;
  chain: readonly RecordMutationRevision[];
}

export interface RecordMutationJournalCas {
  expectedRevision: number;
  expectedDigest: string;
}

export interface CreateRecordMutationJournalInput {
  storageRootPath: string;
  mutationId: string;
  intent: RecordMutationIntent;
  createdAt: number;
  faultInjector?: (
    point: RecordMutationJournalFaultPoint
  ) => void | Promise<void>;
}

export interface StageRecordMutationJournalInput extends RecordMutationJournalCas {
  step: RecordMutationStep;
  updatedAt: number;
  faultInjector?: (
    point: RecordMutationJournalFaultPoint
  ) => void | Promise<void>;
}

export interface CommitRecordMutationJournalInput extends RecordMutationJournalCas {
  committedAt: number;
  message: string;
  faultInjector?: (
    point: RecordMutationJournalFaultPoint
  ) => void | Promise<void>;
}

export interface AbortRecordMutationJournalInput extends RecordMutationJournalCas {
  compensationSteps: readonly RecordMutationStep[];
  compensatingAt: number;
  abortedAt: number;
  code: "compensated" | "recovery-aborted";
  message: string;
  faultInjector?: (
    point: RecordMutationJournalFaultPoint
  ) => void | Promise<void>;
}

type RecordMutationJournalLocator =
  | RecordMutationJournalHandle
  | { storageRootPath: string; mutationId: string };

export async function createRecordMutationJournal(
  input: CreateRecordMutationJournalInput
): Promise<LoadedRecordMutationJournal> {
  try {
    const layout = await requireLayout(input.storageRootPath, true);
    const record = createPlannedRecordMutationRevision(input);
    const handle = makeHandle(layout, record.mutationId);
    await publishDurableAppendOnlyChain(
      layout,
      handle.chainToken,
      entryFileName(0),
      recordBytes(record),
      {
        maxBytes: RECORD_MUTATION_MAX_RECORD_BYTES,
        faultInjector: input.faultInjector,
        preserveStagingOnError: isSimulatedCrash
      }
    );
    const loaded = await loadChain(layout, handle.chainToken, record.mutationId);
    const published = loaded.chain[0];
    if (!published || published.digest !== record.digest) {
      throw journalCorrupt("create readback 与 planned record 不一致");
    }
    return loaded;
  } catch (error) {
    throw mapJournalError(error);
  }
}

export async function loadRecordMutationJournal(
  locator: RecordMutationJournalLocator
): Promise<LoadedRecordMutationJournal> {
  try {
    const { layout, handle } = await resolveHandle(locator);
    return await loadChain(layout, handle.chainToken, handle.mutationId);
  } catch (error) {
    throw mapJournalError(error);
  }
}

export async function listRecordMutationJournals(
  storageRootPath: string
): Promise<LoadedRecordMutationJournal[]> {
  try {
    const layout = await resolveDurableAppendOnlyLayout(
      storageRootPath,
      JOURNAL_DIRECTORY,
      false
    );
    if (!layout) return [];
    await validateStagingNamespace(layout);
    const entries = await boundedReadDir(layout.namespaceRootPath);
    const loaded: LoadedRecordMutationJournal[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".staging") {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw unsafeEntry("record mutation staging namespace 不安全");
        }
        continue;
      }
      if (
        !CHAIN_TOKEN_PATTERN.test(entry.name)
        || !entry.isDirectory()
        || entry.isSymbolicLink()
      ) {
        throw unsafeEntry(`record mutation journal 含未知项：${entry.name}`);
      }
      loaded.push(await loadChain(layout, entry.name));
    }
    return loaded.sort((left, right) => (
      left.record.createdAt - right.record.createdAt
      || left.record.mutationId.localeCompare(right.record.mutationId)
    ));
  } catch (error) {
    throw mapJournalError(error);
  }
}

export async function stageRecordMutationJournal(
  locator: RecordMutationJournalLocator,
  input: StageRecordMutationJournalInput
): Promise<LoadedRecordMutationJournal> {
  return await appendTransition(locator, input, (current) => (
    transitionRecordMutationRevision(current, {
      state: "staged",
      step: input.step,
      terminal: null,
      updatedAt: input.updatedAt
    })
  ));
}

export async function commitRecordMutationJournal(
  locator: RecordMutationJournalLocator,
  input: CommitRecordMutationJournalInput
): Promise<LoadedRecordMutationJournal> {
  return await appendTransition(locator, input, (current) => (
    transitionRecordMutationRevision(current, {
      state: "committed",
      step: null,
      terminal: {
        at: input.committedAt,
        code: "committed",
        message: input.message
      },
      updatedAt: input.committedAt
    })
  ));
}

export async function beginRecordMutationCompensation(
  locator: RecordMutationJournalLocator,
  input: {
    expectedRevision: number;
    expectedDigest: string;
    step: RecordMutationStep;
    updatedAt: number;
    faultInjector?: (
      point: RecordMutationJournalFaultPoint
    ) => void | Promise<void>;
  }
): Promise<LoadedRecordMutationJournal> {
  return await appendTransition(locator, input, (current) => (
    transitionRecordMutationRevision(current, {
      state: "compensating",
      step: input.step,
      terminal: null,
      updatedAt: input.updatedAt
    })
  ));
}

export async function finalizeRecordMutationAbort(
  locator: RecordMutationJournalLocator,
  input: {
    expectedRevision: number;
    expectedDigest: string;
    abortedAt: number;
    code: "compensated" | "recovery-aborted";
    message: string;
    faultInjector?: (
      point: RecordMutationJournalFaultPoint
    ) => void | Promise<void>;
  }
): Promise<LoadedRecordMutationJournal> {
  return await appendTransition(locator, input, (current) => (
    transitionRecordMutationRevision(current, {
      state: "aborted",
      step: null,
      terminal: {
        at: input.abortedAt,
        code: input.code,
        message: input.message
      },
      updatedAt: input.abortedAt
    })
  ));
}

/**
 * High-level abort path. Its first compensating revision races the committed
 * revision for the same N+1 slot, so committed and aborted cannot both win.
 */
export async function abortRecordMutationJournal(
  locator: RecordMutationJournalLocator,
  input: AbortRecordMutationJournalInput
): Promise<LoadedRecordMutationJournal> {
  if (!input.compensationSteps.length) {
    throw new RecordMutationJournalError(
      "journal_blocked",
      "record mutation abort 缺少 compensation step"
    );
  }
  let currentLocator = locator;
  let expectedRevision = input.expectedRevision;
  let expectedDigest = input.expectedDigest;
  let compensating: LoadedRecordMutationJournal | null = null;
  for (let index = 0; index < input.compensationSteps.length; index += 1) {
    compensating = await beginRecordMutationCompensation(currentLocator, {
      expectedRevision,
      expectedDigest,
      step: input.compensationSteps[index],
      updatedAt: input.compensatingAt + index,
      faultInjector: input.faultInjector
    });
    currentLocator = compensating.handle;
    expectedRevision = compensating.record.revision;
    expectedDigest = compensating.record.digest;
  }
  if (!compensating) {
    throw new RecordMutationJournalError(
      "journal_blocked",
      "record mutation abort 未进入 compensating"
    );
  }
  return await finalizeRecordMutationAbort(compensating.handle, {
    expectedRevision: compensating.record.revision,
    expectedDigest: compensating.record.digest,
    abortedAt: input.abortedAt,
    code: input.code,
    message: input.message
  });
}

async function appendTransition(
  locator: RecordMutationJournalLocator,
  input: RecordMutationJournalCas & {
    faultInjector?: (
      point: RecordMutationJournalFaultPoint
    ) => void | Promise<void>;
  },
  build: (current: RecordMutationRevision) => RecordMutationRevision
): Promise<LoadedRecordMutationJournal> {
  try {
    const { layout, handle } = await resolveHandle(locator);
    const current = await loadChain(layout, handle.chainToken, handle.mutationId);
    assertExpectedCas(current.record, input);
    let next: RecordMutationRevision;
    try {
      next = build(current.record);
      assertRecordMutationTransition(current.record, next);
    } catch (error) {
      if (
        error instanceof RecordMutationContractError
        && error.code === "invalid_transition"
      ) {
        throw new RecordMutationJournalError(
          "invalid_transition",
          error.message
        );
      }
      throw error;
    }
    try {
      assertRecordMutationChainCompleteness([...current.chain, next]);
    } catch (error) {
      if (error instanceof RecordMutationContractError) {
        throw new RecordMutationJournalError(
          "journal_blocked",
          error.message
        );
      }
      throw error;
    }
    await publishDurableAppendOnlyEntry(
      layout,
      handle.chainToken,
      entryFileName(next.revision),
      recordBytes(next),
      {
        maxBytes: RECORD_MUTATION_MAX_RECORD_BYTES,
        faultInjector: input.faultInjector,
        preserveStagingOnError: isSimulatedCrash
      }
    );
    const readback = await loadChain(layout, handle.chainToken, handle.mutationId);
    const published = readback.chain[next.revision];
    if (!published || published.digest !== next.digest) {
      throw new RecordMutationJournalError(
        "revision_conflict",
        "record mutation append winner 与当前 writer 不一致"
      );
    }
    return readback;
  } catch (error) {
    throw mapJournalError(error);
  }
}

async function resolveHandle(
  locator: RecordMutationJournalLocator
): Promise<{ layout: DurableAppendOnlyLayout; handle: RecordMutationJournalHandle }> {
  const layout = await requireLayout(locator.storageRootPath, false);
  const expected = makeHandle(layout, locator.mutationId);
  if ("chainRootPath" in locator) {
    for (const key of [
      "storageRootPath",
      "journalRootPath",
      "stagingRootPath",
      "chainRootPath"
    ] as const) {
      if (path.resolve(locator[key]) !== path.resolve(expected[key])) {
        throw new RecordMutationJournalError(
          "invalid_path",
          `record mutation handle ${key} 不匹配`
        );
      }
    }
    if (locator.chainToken !== expected.chainToken) {
      throw new RecordMutationJournalError(
        "invalid_path",
        "record mutation handle token 不匹配"
      );
    }
  }
  return { layout, handle: expected };
}

async function requireLayout(
  storageRootPath: string,
  create: boolean
): Promise<DurableAppendOnlyLayout> {
  const layout = await resolveDurableAppendOnlyLayout(
    storageRootPath,
    JOURNAL_DIRECTORY,
    create
  );
  if (!layout) {
    throw new RecordMutationJournalError(
      "journal_missing",
      "record mutation journal namespace 不存在"
    );
  }
  return layout;
}

function makeHandle(
  layout: DurableAppendOnlyLayout,
  mutationId: string
): RecordMutationJournalHandle {
  const planned = createPlannedRecordMutationRevision({
    mutationId,
    intent: {
      operation: "start-new-context",
      conversationId: "handle-validation",
      expectedConversationGeneration: 0,
      expectedConversationCommitId: null,
      participants: [{
        id: "conversation",
        recordKind: "conversation",
        action: "retain"
      }],
      rootBindings: [],
      trashPolicy: "not-required"
    },
    createdAt: 0
  });
  const normalizedMutationId = planned.mutationId;
  const chainToken = mutationToken(normalizedMutationId);
  return {
    storageRootPath: layout.storageRootPath,
    journalRootPath: layout.namespaceRootPath,
    stagingRootPath: layout.stagingRootPath,
    chainToken,
    chainRootPath: durableAppendOnlyChainPath(layout, chainToken),
    mutationId: normalizedMutationId
  };
}

async function loadChain(
  layout: DurableAppendOnlyLayout,
  chainToken: string,
  expectedMutationId?: string
): Promise<LoadedRecordMutationJournal> {
  if (!CHAIN_TOKEN_PATTERN.test(chainToken)) {
    throw unsafeEntry(`record mutation chain token 非法：${chainToken}`);
  }
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  const chainStat = await durableLstatOrNull(chainRootPath);
  if (!chainStat) {
    throw new RecordMutationJournalError(
      "journal_missing",
      `record mutation chain 不存在：${chainToken}`
    );
  }
  assertDurableDirectoryStat(chainStat, "record mutation chain");
  const entries = await boundedReadDir(chainRootPath);
  if (!entries.length || entries.length > RECORD_MUTATION_MAX_REVISIONS) {
    throw journalCorrupt("record mutation revision 数量非法");
  }
  const ordered = entries.map((entry) => {
    const match = ENTRY_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw unsafeEntry(`record mutation chain 含未知 entry：${entry.name}`);
    }
    const revision = Number(match[1]);
    if (!Number.isSafeInteger(revision)) {
      throw journalCorrupt(`record mutation revision 文件名非法：${entry.name}`);
    }
    return { entry, revision };
  }).sort((left, right) => left.revision - right.revision);

  const chain: RecordMutationRevision[] = [];
  let recordPath = "";
  for (let index = 0; index < ordered.length; index += 1) {
    const { entry, revision } = ordered[index];
    if (revision !== index || entry.name !== entryFileName(index)) {
      throw journalCorrupt("record mutation revision 必须从 0 连续");
    }
    recordPath = path.join(chainRootPath, entry.name);
    const raw = await readDurableRegularFile(
      recordPath,
      RECORD_MUTATION_MAX_RECORD_BYTES,
      [1, 2]
    );
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.content.toString("utf8")) as unknown;
    } catch (error) {
      throw journalCorrupt(`record mutation JSON 损坏：${errorMessage(error)}`);
    }
    let record: RecordMutationRevision;
    try {
      record = parseRecordMutationRevision(parsedJson);
    } catch (error) {
      throw journalCorrupt(`record mutation schema/digest 损坏：${errorMessage(error)}`);
    }
    if (
      record.revision !== index
      || mutationToken(record.mutationId) !== chainToken
      || (expectedMutationId !== undefined && record.mutationId !== expectedMutationId)
    ) {
      throw journalCorrupt("record mutation entry identity 与路径不匹配");
    }
    if (chain.length) {
      try {
        assertRecordMutationTransition(chain[chain.length - 1], record);
      } catch (error) {
        throw journalCorrupt(`record mutation chain 非单调：${errorMessage(error)}`);
      }
    }
    chain.push(record);
  }
  try {
    assertRecordMutationChainCompleteness(chain);
  } catch (error) {
    throw journalCorrupt(
      `record mutation terminal evidence 不完整：${errorMessage(error)}`
    );
  }
  const current = chain[chain.length - 1];
  const handle = makeHandle(layout, current.mutationId);
  return { handle, record: current, recordPath, chain };
}

async function validateStagingNamespace(
  layout: DurableAppendOnlyLayout
): Promise<void> {
  const entries = await boundedReadDir(layout.stagingRootPath);
  for (const entry of entries) {
    const entryPath = path.join(layout.stagingRootPath, entry.name);
    if (STAGED_CREATE_PATTERN.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw unsafeEntry(`record mutation staged create 不安全：${entry.name}`);
      }
      const stagedEntries = await boundedReadDir(entryPath);
      if (stagedEntries.length > 1) {
        throw unsafeEntry("record mutation staged create 含多个文件");
      }
      for (const staged of stagedEntries) {
        if (
          staged.name !== entryFileName(0)
          || !staged.isFile()
          || staged.isSymbolicLink()
        ) {
          throw unsafeEntry(`record mutation staged create 含未知项：${staged.name}`);
        }
        assertDurableRegularFileStat(
          await fsp.lstat(path.join(entryPath, staged.name)),
          "record mutation staged create entry",
          [1, 2]
        );
      }
      continue;
    }
    if (
      !STAGED_ENTRY_PATTERN.test(entry.name)
      || !entry.isFile()
      || entry.isSymbolicLink()
    ) {
      throw unsafeEntry(`record mutation staging 含未知项：${entry.name}`);
    }
    assertDurableRegularFileStat(
      await fsp.lstat(entryPath),
      "record mutation staged entry",
      [1, 2]
    );
  }
}

async function boundedReadDir(
  directoryPath: string
): Promise<Dirent<string>[]> {
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  if (entries.length > MAX_NAMESPACE_ENTRIES) {
    throw unsafeEntry("record mutation namespace entry 数量超过上限");
  }
  return entries;
}

function assertExpectedCas(
  current: RecordMutationRevision,
  expected: RecordMutationJournalCas
): void {
  if (
    !Number.isSafeInteger(expected.expectedRevision)
    || expected.expectedRevision < 0
    || !/^sha256:[a-f0-9]{64}$/.test(expected.expectedDigest)
    || current.revision !== expected.expectedRevision
    || current.digest !== expected.expectedDigest
  ) {
    throw new RecordMutationJournalError(
      "revision_conflict",
      `record mutation CAS 冲突：当前 revision=${current.revision}`
    );
  }
}

function entryFileName(revision: number): string {
  if (
    !Number.isSafeInteger(revision)
    || revision < 0
    || revision >= RECORD_MUTATION_MAX_REVISIONS
  ) {
    throw journalCorrupt(`record mutation revision 越界：${revision}`);
  }
  return `${ENTRY_PREFIX}${String(revision).padStart(ENTRY_WIDTH, "0")}.json`;
}

function mutationToken(mutationId: string): string {
  return `mutation-${createHash("sha256")
    .update(Buffer.from(mutationId, "utf8"))
    .digest("hex")
    .slice(0, 24)}`;
}

function recordBytes(record: RecordMutationRevision): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function mapJournalError(error: unknown): Error {
  if (
    error instanceof RecordMutationJournalError
    || error instanceof RecordMutationJournalSimulatedCrash
  ) {
    return error;
  }
  if (error instanceof RecordMutationContractError) {
    if (error.code === "invalid_transition") {
      return new RecordMutationJournalError("invalid_transition", error.message);
    }
    return new RecordMutationJournalError("journal_corrupt", error.message);
  }
  if (error instanceof DurableAppendOnlyCasError) {
    const code: RecordMutationJournalErrorCode = (
      error.code === "already_exists" ? "journal_exists"
        : error.code === "missing" ? "journal_missing"
          : error.code === "revision_conflict" ? "revision_conflict"
            : error.code === "invalid_path" ? "invalid_path"
              : "unsafe_entry"
    );
    return new RecordMutationJournalError(code, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isSimulatedCrash(error: unknown): boolean {
  return error instanceof RecordMutationJournalSimulatedCrash;
}

function unsafeEntry(message: string): RecordMutationJournalError {
  return new RecordMutationJournalError("unsafe_entry", message);
}

function journalCorrupt(message: string): RecordMutationJournalError {
  return new RecordMutationJournalError("journal_corrupt", message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
