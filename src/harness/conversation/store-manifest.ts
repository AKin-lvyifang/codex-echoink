import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  assertRecordMigrationValidationProof,
  type RecordMigrationValidationProof
} from "../lifecycle/record-migration-validator";

const MANIFEST_SCHEMA_VERSION = 1 as const;
const MANIFEST_DIRECTORY = "conversation-store-manifest";
const MANIFEST_STAGING_DIRECTORY = ".conversation-store-manifest-staging";
const ACTIVE_FENCE_FILE = "conversation-store-v2-active.json";
const ENTRY_PREFIX = "entry-";
const ENTRY_WIDTH = 16;
const ENTRY_PATTERN = /^entry-([0-9]{16})\.json$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export const CONVERSATION_STORE_MANIFEST_SCHEMA_VERSION =
  MANIFEST_SCHEMA_VERSION;

export type ConversationStoreManifestMigrationState =
  | "copying"
  | "validated"
  | "active";

export interface ConversationStoreManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  recordType: "conversation-store-manifest";
  migrationState: ConversationStoreManifestMigrationState;
  activeStore: "v1" | "v2";
  sourceStore: "v1";
  targetStore: "v2";
  sourceFingerprint: string;
  targetFingerprint: string | null;
  revision: number;
  commitId: string;
  previousRevision: number | null;
  previousCommitId: string | null;
  previousDigest: string | null;
  createdAt: number;
  updatedAt: number;
  activatedAt: number | null;
  digest: string;
}

export interface ConversationStoreManifestCasExpectation {
  expectedRevision: number | null;
  expectedCommitId: string | null;
}

export interface ConversationStoreSelection {
  activeStore: "v1" | "v2";
  reason:
    | "manifest-absent"
    | "migration-incomplete"
    | "active-cutover-pending"
    | "manifest-active";
  manifest: ConversationStoreManifest | null;
}

export type ConversationStoreManifestErrorCode =
  | "invalid-record"
  | "missing-field"
  | "unexpected-field"
  | "unknown-schema"
  | "future-schema"
  | "invalid-value"
  | "unsafe-entry"
  | "corrupt-chain"
  | "revision-conflict"
  | "invalid-transition"
  | "rollback-requires-export";

export class ConversationStoreManifestError extends Error {
  constructor(
    public readonly code: ConversationStoreManifestErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConversationStoreManifestError";
  }
}

export interface FileConversationStoreManifestOptions {
  storageRootPath: string;
  faultInjector?: (
    point: "after-active-fence",
    manifest: ConversationStoreManifest
  ) => void | Promise<void>;
}

export function conversationStoreManifestRoot(
  storageRootPath: string
): string {
  return path.join(path.resolve(storageRootPath), MANIFEST_DIRECTORY);
}

export function createCopyingConversationStoreManifest(input: {
  commitId: string;
  sourceFingerprint: string;
  createdAt: number;
}): ConversationStoreManifest {
  return finalizeManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    recordType: "conversation-store-manifest",
    migrationState: "copying",
    activeStore: "v1",
    sourceStore: "v1",
    targetStore: "v2",
    sourceFingerprint: input.sourceFingerprint,
    targetFingerprint: null,
    revision: 0,
    commitId: input.commitId,
    previousRevision: null,
    previousCommitId: null,
    previousDigest: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    activatedAt: null
  });
}

export function finalizeConversationStoreManifest(
  value: Omit<ConversationStoreManifest, "digest">
): ConversationStoreManifest {
  return finalizeManifest(value);
}

export function advanceConversationStoreManifestToValidated(
  current: ConversationStoreManifest,
  input: {
    commitId: string;
    proof: RecordMigrationValidationProof;
    updatedAt: number;
  }
): ConversationStoreManifest {
  validateConversationStoreManifest(current);
  if (current.migrationState !== "copying") {
    throw manifestError(
      "invalid-transition",
      "Conversation Store manifest 只能从 copying 进入 validated"
    );
  }
  assertRecordMigrationValidationProof(input.proof, {
    domain: "conversation",
    sourceFingerprint: current.sourceFingerprint,
    targetFingerprint: input.proof.report.targetFingerprint
  });
  return finalizeManifest({
    ...manifestWithoutDigest(current),
    migrationState: "validated",
    activeStore: "v1",
    targetFingerprint: input.proof.report.targetFingerprint,
    revision: current.revision + 1,
    commitId: input.commitId,
    previousRevision: current.revision,
    previousCommitId: current.commitId,
    previousDigest: current.digest,
    updatedAt: input.updatedAt,
    activatedAt: null
  });
}

export function advanceConversationStoreManifestToActive(
  current: ConversationStoreManifest,
  input: {
    commitId: string;
    activatedAt: number;
  }
): ConversationStoreManifest {
  validateConversationStoreManifest(current);
  if (current.migrationState !== "validated") {
    throw manifestError(
      "invalid-transition",
      "Conversation Store manifest 只能从 validated 进入 active"
    );
  }
  return finalizeManifest({
    ...manifestWithoutDigest(current),
    migrationState: "active",
    activeStore: "v2",
    revision: current.revision + 1,
    commitId: input.commitId,
    previousRevision: current.revision,
    previousCommitId: current.commitId,
    previousDigest: current.digest,
    updatedAt: input.activatedAt,
    activatedAt: input.activatedAt
  });
}

export function validateConversationStoreManifest(
  value: unknown
): ConversationStoreManifest {
  const record = requireRecord(value, "Conversation Store manifest");
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "migrationState",
    "activeStore",
    "sourceStore",
    "targetStore",
    "sourceFingerprint",
    "targetFingerprint",
    "revision",
    "commitId",
    "previousRevision",
    "previousCommitId",
    "previousDigest",
    "createdAt",
    "updatedAt",
    "activatedAt",
    "digest"
  ], "Conversation Store manifest");
  assertSchemaVersion(record.schemaVersion);
  if (record.recordType !== "conversation-store-manifest") {
    throw manifestError("invalid-value", "Conversation Store manifest recordType 非法");
  }
  if (
    record.migrationState !== "copying"
    && record.migrationState !== "validated"
    && record.migrationState !== "active"
  ) {
    throw manifestError("invalid-value", "Conversation Store migrationState 非法");
  }
  if (record.activeStore !== "v1" && record.activeStore !== "v2") {
    throw manifestError("invalid-value", "Conversation Store activeStore 非法");
  }
  if (record.sourceStore !== "v1" || record.targetStore !== "v2") {
    throw manifestError("invalid-value", "Conversation Store source/target 非法");
  }
  requireDigest(record.sourceFingerprint, "sourceFingerprint");
  if (record.targetFingerprint !== null) {
    requireDigest(record.targetFingerprint, "targetFingerprint");
  }
  requireNonNegativeInteger(record.revision, "revision");
  requireIdentifier(record.commitId, "commitId");
  validateNullableNonNegativeInteger(record.previousRevision, "previousRevision");
  validateNullableIdentifier(record.previousCommitId, "previousCommitId");
  validateNullableDigest(record.previousDigest, "previousDigest");
  requireTimestamp(record.createdAt, "createdAt");
  requireTimestamp(record.updatedAt, "updatedAt");
  validateNullableTimestamp(record.activatedAt, "activatedAt");
  requireDigest(record.digest, "digest");
  if ((record.updatedAt as number) < (record.createdAt as number)) {
    throw manifestError("invalid-value", "manifest updatedAt 早于 createdAt");
  }
  assertManifestStateShape(record);
  const { digest, ...withoutDigest } = record;
  if (digest !== digestManifest(withoutDigest)) {
    throw manifestError("corrupt-chain", "Conversation Store manifest digest 不匹配");
  }
  return record as unknown as ConversationStoreManifest;
}

export class FileConversationStoreManifest {
  readonly storageRootPath: string;
  readonly manifestRootPath: string;
  readonly stagingRootPath: string;
  readonly activeFencePath: string;
  private readonly faultInjector:
    | FileConversationStoreManifestOptions["faultInjector"]
    | undefined;

  constructor(options: FileConversationStoreManifestOptions) {
    this.storageRootPath = path.resolve(options.storageRootPath);
    this.manifestRootPath = conversationStoreManifestRoot(this.storageRootPath);
    this.stagingRootPath = path.join(
      this.storageRootPath,
      MANIFEST_STAGING_DIRECTORY
    );
    this.activeFencePath = path.join(this.storageRootPath, ACTIVE_FENCE_FILE);
    this.faultInjector = options.faultInjector;
  }

  async read(): Promise<ConversationStoreManifest | null> {
    return await readManifestChain(
      this.manifestRootPath,
      this.activeFencePath,
      true
    );
  }

  async readManifest(): Promise<ConversationStoreManifest | null> {
    return await this.read();
  }

  async compareAndSwap(
    candidateInput: ConversationStoreManifest,
    expectation: ConversationStoreManifestCasExpectation
  ): Promise<ConversationStoreManifest> {
    const candidate = validateConversationStoreManifest(candidateInput);
    const current = await readManifestChain(
      this.manifestRootPath,
      this.activeFencePath,
      true
    );
    await ensureManifestLayout(this);
    assertExpectation(current, expectation);
    assertManifestTransition(current, candidate);
    if (candidate.migrationState === "active") {
      await publishActiveFence(this, candidate);
      await this.faultInjector?.("after-active-fence", candidate);
    }

    const stagedPath = path.join(
      this.stagingRootPath,
      `.manifest-${entryFileName(candidate.revision)}-${randomUUID()}.tmp`
    );
    const targetPath = path.join(
      this.manifestRootPath,
      entryFileName(candidate.revision)
    );
    const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    let staged = false;
    try {
      await writeNewFileDurably(stagedPath, bytes);
      staged = true;
      await syncDirectory(this.stagingRootPath);
      try {
        await fsp.link(stagedPath, targetPath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw manifestError(
            "revision-conflict",
            `Conversation Store manifest revision ${candidate.revision} 已有 winner`
          );
        }
        throw error;
      }
      await syncDirectory(this.manifestRootPath);
      const readback = await readManifestChain(
        this.manifestRootPath,
        this.activeFencePath
      );
      if (
        !readback
        || readback.revision !== candidate.revision
        || readback.commitId !== candidate.commitId
        || readback.digest !== candidate.digest
      ) {
        throw manifestError(
          "revision-conflict",
          "Conversation Store manifest readback 与 CAS winner 不一致"
        );
      }
      await fsp.unlink(stagedPath);
      staged = false;
      await syncDirectory(this.stagingRootPath);
      return readback;
    } catch (error) {
      if (staged) {
        await fsp.unlink(stagedPath).catch(() => undefined);
        await syncDirectory(this.stagingRootPath).catch(() => undefined);
      }
      throw error;
    }
  }

  async readPendingActiveCutover():
  Promise<ConversationStoreManifest | null> {
    const current = await readManifestChain(
      this.manifestRootPath,
      this.activeFencePath,
      true
    );
    const fence = await readActiveFenceOrNull(this.activeFencePath);
    if (!fence || current?.migrationState === "active") return null;
    if (!current || current.migrationState !== "validated") {
      throw manifestError(
        "corrupt-chain",
        "active fence 缺少 validated predecessor"
      );
    }
    assertManifestTransition(current, fence.manifest);
    return fence.manifest;
  }

  async recoverPendingActiveCutover():
  Promise<ConversationStoreManifest | null> {
    const pending = await this.readPendingActiveCutover();
    if (!pending) return await this.read();
    const current = await readManifestChain(
      this.manifestRootPath,
      this.activeFencePath,
      true
    );
    if (!current || current.migrationState !== "validated") {
      throw manifestError(
        "corrupt-chain",
        "active cutover recovery 缺少 validated predecessor"
      );
    }
    return await this.compareAndSwap(pending, {
      expectedRevision: current.revision,
      expectedCommitId: current.commitId
    });
  }
}

export async function resolveConversationStoreSelection(
  storageRootPath: string
): Promise<ConversationStoreSelection> {
  const store = new FileConversationStoreManifest({
    storageRootPath
  });
  const manifest = await store.read();
  if (!manifest) {
    return {
      activeStore: "v1",
      reason: "manifest-absent",
      manifest: null
    };
  }
  const pendingActive = await store.readPendingActiveCutover();
  if (pendingActive) {
    return {
      activeStore: "v1",
      reason: "active-cutover-pending",
      manifest
    };
  }
  if (manifest.migrationState !== "active") {
    return {
      activeStore: "v1",
      reason: "migration-incomplete",
      manifest
    };
  }
  return {
    activeStore: "v2",
    reason: "manifest-active",
    manifest
  };
}

async function readManifestChain(
  manifestRootPath: string,
  activeFencePath: string,
  allowPendingActiveFence = false
): Promise<ConversationStoreManifest | null> {
  const activeFence = await readActiveFenceOrNull(activeFencePath);
  const rootStat = await lstatOrNull(manifestRootPath);
  if (!rootStat) {
    if (activeFence) {
      throw manifestError("corrupt-chain", "active fence exists without manifest chain");
    }
    return null;
  }
  assertPlainDirectory(rootStat, "Conversation Store manifest root");
  const entries = await fsp.readdir(manifestRootPath, { withFileTypes: true });
  if (!entries.length) {
    if (activeFence) {
      throw manifestError("corrupt-chain", "active fence exists without manifest entries");
    }
    return null;
  }
  const ordered = entries.map((entry) => {
    const match = ENTRY_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw manifestError(
        "unsafe-entry",
        `Conversation Store manifest 含未知或不安全 entry：${entry.name}`
      );
    }
    return {
      name: entry.name,
      revision: Number(match[1])
    };
  }).sort((left, right) => left.revision - right.revision);

  let current: ConversationStoreManifest | null = null;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (
      entry.revision !== index
      || entry.name !== entryFileName(index)
    ) {
      throw manifestError(
        "corrupt-chain",
        "Conversation Store manifest revision chain 不连续"
      );
    }
    const value = await readJsonFileSafely(
      path.join(manifestRootPath, entry.name),
      "Conversation Store manifest entry",
      [1, 2]
    );
    const candidate = validateConversationStoreManifest(value);
    if (candidate.revision !== entry.revision) {
      throw manifestError(
        "corrupt-chain",
        "Conversation Store manifest revision 与文件名不一致"
      );
    }
    assertManifestTransition(current, candidate);
    current = candidate;
  }
  if (activeFence) {
    const matchesCurrent = current?.migrationState === "active"
      && activeFence.manifest.revision === current.revision
      && activeFence.manifest.commitId === current.commitId
      && activeFence.manifest.digest === current.digest;
    let isPending = false;
    if (
      allowPendingActiveFence
      && current?.migrationState === "validated"
    ) {
      try {
        assertManifestTransition(current, activeFence.manifest);
        isPending = true;
      } catch {
        isPending = false;
      }
    }
    if (!matchesCurrent && !isPending) {
      throw manifestError("corrupt-chain", "active fence 与 manifest chain 不一致");
    }
  } else if (current?.migrationState === "active") {
    throw manifestError("corrupt-chain", "active manifest 缺少不可逆 active fence");
  }
  return current;
}

interface ConversationStoreActiveFence {
  schemaVersion: 2;
  recordType: "conversation-store-active-fence";
  manifest: ConversationStoreManifest;
}

async function publishActiveFence(
  store: FileConversationStoreManifest,
  manifest: ConversationStoreManifest
): Promise<void> {
  const fence: ConversationStoreActiveFence = {
    schemaVersion: 2,
    recordType: "conversation-store-active-fence",
    manifest
  };
  const bytes = Buffer.from(`${JSON.stringify(fence, null, 2)}\n`, "utf8");
  try {
    await writeNewFileDurably(store.activeFencePath, bytes);
    await syncDirectory(store.storageRootPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readActiveFenceOrNull(store.activeFencePath);
    if (
      !existing
      || existing.manifest.revision !== fence.manifest.revision
      || existing.manifest.commitId !== fence.manifest.commitId
      || existing.manifest.digest !== fence.manifest.digest
    ) {
      throw manifestError("revision-conflict", "active fence 已由另一个 cutover winner 占用");
    }
  }
}

async function readActiveFenceOrNull(
  activeFencePath: string
): Promise<ConversationStoreActiveFence | null> {
  if (!await lstatOrNull(activeFencePath)) return null;
  const record = requireRecord(
    await readJsonFileSafely(activeFencePath, "Conversation Store active fence", [1]),
    "Conversation Store active fence"
  );
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "manifest"
  ], "Conversation Store active fence");
  if (
    record.schemaVersion !== 2
    || record.recordType !== "conversation-store-active-fence"
  ) {
    throw manifestError("corrupt-chain", "Conversation Store active fence 非法");
  }
  const manifest = validateConversationStoreManifest(record.manifest);
  if (
    manifest.migrationState !== "active"
    || manifest.activeStore !== "v2"
  ) {
    throw manifestError(
      "corrupt-chain",
      "Conversation Store active fence 未绑定 active manifest"
    );
  }
  return {
    schemaVersion: 2,
    recordType: "conversation-store-active-fence",
    manifest
  };
}

function assertManifestTransition(
  current: ConversationStoreManifest | null,
  candidate: ConversationStoreManifest
): void {
  if (!current) {
    if (
      candidate.revision !== 0
      || candidate.migrationState !== "copying"
      || candidate.previousRevision !== null
      || candidate.previousCommitId !== null
      || candidate.previousDigest !== null
    ) {
      throw manifestError(
        "invalid-transition",
        "Conversation Store manifest 必须从 copying revision 0 开始"
      );
    }
    return;
  }
  if (current.migrationState === "active") {
    throw manifestError(
      candidate.activeStore === "v1" || candidate.migrationState !== "active"
        ? "rollback-requires-export"
        : "invalid-transition",
      "V2 active 后禁止直接切回 V1；必须先执行 V2 to V1 exporter"
    );
  }
  if (
    candidate.revision !== current.revision + 1
    || candidate.previousRevision !== current.revision
    || candidate.previousCommitId !== current.commitId
    || candidate.previousDigest !== current.digest
    || candidate.createdAt !== current.createdAt
    || candidate.sourceFingerprint !== current.sourceFingerprint
  ) {
    throw manifestError(
      "invalid-transition",
      "Conversation Store manifest chain linkage 非法"
    );
  }
  if (candidate.updatedAt < current.updatedAt) {
    throw manifestError(
      "invalid-transition",
      "Conversation Store manifest updatedAt 不能倒退"
    );
  }
  if (
    (current.migrationState === "copying"
      && candidate.migrationState !== "validated")
    || (current.migrationState === "validated"
      && candidate.migrationState !== "active")
  ) {
    throw manifestError(
      "invalid-transition",
      "Conversation Store migration 必须按 copying -> validated -> active 推进"
    );
  }
  if (
    current.targetFingerprint !== null
    && candidate.targetFingerprint !== current.targetFingerprint
  ) {
    throw manifestError(
      "invalid-transition",
      "Conversation Store targetFingerprint 不能改变"
    );
  }
}

function assertManifestStateShape(record: Record<string, unknown>): void {
  if (record.migrationState === "copying") {
    if (
      record.activeStore !== "v1"
      || record.targetFingerprint !== null
      || record.activatedAt !== null
    ) {
      throw manifestError("invalid-value", "copying manifest 状态字段不一致");
    }
    return;
  }
  if (record.migrationState === "validated") {
    if (
      record.activeStore !== "v1"
      || record.targetFingerprint === null
      || record.activatedAt !== null
    ) {
      throw manifestError("invalid-value", "validated manifest 状态字段不一致");
    }
    return;
  }
  if (
    record.activeStore !== "v2"
    || record.targetFingerprint === null
    || record.activatedAt === null
  ) {
    throw manifestError("invalid-value", "active manifest 状态字段不一致");
  }
}

function assertExpectation(
  current: ConversationStoreManifest | null,
  expectation: ConversationStoreManifestCasExpectation
): void {
  const currentRevision = current?.revision ?? null;
  const currentCommitId = current?.commitId ?? null;
  if (
    currentRevision !== expectation.expectedRevision
    || currentCommitId !== expectation.expectedCommitId
  ) {
    throw manifestError(
      "revision-conflict",
      "Conversation Store manifest CAS expectation 已过期"
    );
  }
}

async function ensureManifestLayout(
  store: FileConversationStoreManifest
): Promise<void> {
  await ensurePlainDirectory(store.storageRootPath);
  await ensurePlainDirectory(store.manifestRootPath);
  await ensurePlainDirectory(store.stagingRootPath);
}

async function ensurePlainDirectory(absolutePath: string): Promise<void> {
  const before = await lstatOrNull(absolutePath);
  if (!before) {
    await fsp.mkdir(absolutePath, { recursive: false, mode: 0o700 });
  }
  const after = await fsp.lstat(absolutePath);
  assertPlainDirectory(after, absolutePath);
}

function assertPlainDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw manifestError("unsafe-entry", `${label} 必须是非 symlink 目录`);
  }
}

async function readJsonFileSafely(
  absolutePath: string,
  label: string,
  allowedLinkCounts: readonly number[]
): Promise<unknown> {
  const handle = await fsp.open(
    absolutePath,
    fsConstants.O_RDONLY | noFollowFlag()
  ).catch((error) => {
    throw manifestError(
      "unsafe-entry",
      `${label} 无法安全打开：${errorMessage(error)}`
    );
  });
  try {
    const before = await handle.stat();
    assertSafeRegularFile(before, label, allowedLinkCounts);
    if (before.size > MAX_MANIFEST_BYTES) {
      throw manifestError("unsafe-entry", `${label} 超过安全大小上限`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileVersion(before, after) || bytes.byteLength !== before.size) {
      throw manifestError("unsafe-entry", `${label} 读取期间发生变化`);
    }
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw manifestError(
        "corrupt-chain",
        `${label} JSON 无法解析：${errorMessage(error)}`
      );
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeNewFileDurably(
  absolutePath: string,
  bytes: Buffer
): Promise<void> {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw manifestError("invalid-value", "Conversation Store manifest 超过大小上限");
  }
  const handle = await fsp.open(
    absolutePath,
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
    assertSafeRegularFile(
      await handle.stat(),
      "new Conversation Store manifest entry",
      [1]
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncDirectory(absolutePath: string): Promise<void> {
  const handle = await fsp.open(absolutePath, fsConstants.O_RDONLY | noFollowFlag());
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
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
    throw manifestError("unsafe-entry", `${label} 必须是安全 regular file`);
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

function entryFileName(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw manifestError("invalid-value", `manifest revision 非法：${revision}`);
  }
  const digits = String(revision);
  if (digits.length > ENTRY_WIDTH) {
    throw manifestError("invalid-value", "manifest revision 超过文件名上限");
  }
  return `${ENTRY_PREFIX}${digits.padStart(ENTRY_WIDTH, "0")}.json`;
}

function finalizeManifest(
  value: Omit<ConversationStoreManifest, "digest">
): ConversationStoreManifest {
  const manifest = {
    ...value,
    digest: digestManifest(value)
  };
  validateConversationStoreManifest(manifest);
  return manifest;
}

function manifestWithoutDigest(
  value: ConversationStoreManifest
): Omit<ConversationStoreManifest, "digest"> {
  const { digest: _digest, ...withoutDigest } = value;
  return withoutDigest;
}

function digestManifest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = requireRecord(value, "manifest canonical JSON");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requireRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw manifestError("invalid-record", `${label} 必须是普通对象`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw manifestError("unexpected-field", `${label} 含未知字段：${key}`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw manifestError("missing-field", `${label} 缺少字段：${key}`);
    }
  }
}

function assertSchemaVersion(value: unknown): void {
  if (value === MANIFEST_SCHEMA_VERSION) return;
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value > MANIFEST_SCHEMA_VERSION
  ) {
    throw manifestError("future-schema", `future manifest schema：${value}`);
  }
  throw manifestError("unknown-schema", "manifest schemaVersion 未知");
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value.length
    || value.trim() !== value
    || value.length > 512
    || hasUnsafeControlCharacter(value)
  ) {
    throw manifestError("invalid-value", `manifest ${label} 非法`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw manifestError("invalid-value", `manifest ${label} 非法`);
  }
  return value;
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 8
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127
    ) return true;
  }
  return false;
}

function validateNullableDigest(value: unknown, label: string): void {
  if (value !== null) requireDigest(value, label);
}

function validateNullableIdentifier(value: unknown, label: string): void {
  if (value !== null) requireIdentifier(value, label);
}

function validateNullableNonNegativeInteger(value: unknown, label: string): void {
  if (value !== null) requireNonNegativeInteger(value, label);
}

function validateNullableTimestamp(value: unknown, label: string): void {
  if (value !== null) requireTimestamp(value, label);
}

function requireTimestamp(value: unknown, label: string): number {
  return requireNonNegativeInteger(value, label);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw manifestError("invalid-value", `manifest ${label} 非法`);
  }
  return value;
}

function noFollowFlag(): number {
  return (
    (fsConstants as unknown as Record<string, number>).O_NOFOLLOW
    ?? 0
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST"
  );
}

async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
  return await fsp.lstat(absolutePath).catch((error) => {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
    ) return null;
    throw error;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function manifestError(
  code: ConversationStoreManifestErrorCode,
  message: string
): ConversationStoreManifestError {
  return new ConversationStoreManifestError(code, message);
}
