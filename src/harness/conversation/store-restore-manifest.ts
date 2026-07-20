import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  assertRecordMigrationValidationProof,
  type RecordMigrationValidationProof
} from "../lifecycle/record-migration-validator";
import {
  assertConversationStoreV1ExportDirectoryChain,
  assertConversationStoreV1ExportGenerationId,
  conversationStoreV1ExportGenerationRoot
} from "./conversation-store-paths";
import {
  FileConversationStoreManifest,
  type ConversationStoreManifest
} from "./store-manifest";

const RESTORE_MANIFEST_SCHEMA_VERSION = 1 as const;
const RESTORE_MANIFEST_DIRECTORY =
  "conversation-store-v1-restore-manifest";
const RESTORE_STAGING_DIRECTORY =
  ".conversation-store-v1-restore-manifest-staging";
const RESTORE_ACTIVE_FENCE_FILE =
  "conversation-store-v1-restore-active.json";
const EXPORT_PLAN_FILE = "plan.json";
const ENTRY_PREFIX = "entry-";
const ENTRY_WIDTH = 16;
const ENTRY_PATTERN = /^entry-([0-9]{16})\.json$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 1024 * 1024;

export type ConversationStoreRestoreMigrationState =
  | "reverse-copying"
  | "reverse-validated"
  | "reverse-active";

export interface ConversationStoreRestoreManifest {
  schemaVersion: typeof RESTORE_MANIFEST_SCHEMA_VERSION;
  recordType: "conversation-store-v1-restore-manifest";
  migrationState: ConversationStoreRestoreMigrationState;
  activeStore: "v2" | "v1";
  sourceStore: "v2";
  targetStore: "v1";
  sourceManifestDigest: string;
  sourceFingerprint: string;
  targetFingerprint: string | null;
  generationId: string;
  planDigest: string;
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

export interface ConversationStoreRestoreManifestCasExpectation {
  expectedRevision: number | null;
  expectedCommitId: string | null;
}

export type ConversationStoreRestoreManifestErrorCode =
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
  | "source-not-active";

export class ConversationStoreRestoreManifestError extends Error {
  constructor(
    public readonly code: ConversationStoreRestoreManifestErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConversationStoreRestoreManifestError";
  }
}

export interface FileConversationStoreRestoreManifestOptions {
  storageRootPath: string;
  faultInjector?: (
    point: "after-restore-active-fence",
    manifest: ConversationStoreRestoreManifest
  ) => void | Promise<void>;
}

export function conversationStoreRestoreManifestRoot(
  storageRootPath: string
): string {
  return path.join(
    path.resolve(storageRootPath),
    RESTORE_MANIFEST_DIRECTORY
  );
}

export function createCopyingConversationStoreRestoreManifest(input: {
  commitId: string;
  sourceManifestDigest: string;
  sourceFingerprint: string;
  generationId: string;
  planDigest: string;
  createdAt: number;
}): ConversationStoreRestoreManifest {
  return finalizeRestoreManifest({
    schemaVersion: RESTORE_MANIFEST_SCHEMA_VERSION,
    recordType: "conversation-store-v1-restore-manifest",
    migrationState: "reverse-copying",
    activeStore: "v2",
    sourceStore: "v2",
    targetStore: "v1",
    sourceManifestDigest: input.sourceManifestDigest,
    sourceFingerprint: input.sourceFingerprint,
    targetFingerprint: null,
    generationId: input.generationId,
    planDigest: input.planDigest,
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

export function advanceConversationStoreRestoreManifestToValidated(
  current: ConversationStoreRestoreManifest,
  input: {
    commitId: string;
    proof: RecordMigrationValidationProof;
    updatedAt: number;
  }
): ConversationStoreRestoreManifest {
  validateConversationStoreRestoreManifest(current);
  if (current.migrationState !== "reverse-copying") {
    throw restoreError(
      "invalid-transition",
      "Conversation restore manifest must enter validated from copying"
    );
  }
  assertReverseProof(current, input.proof);
  return finalizeRestoreManifest({
    ...restoreManifestWithoutDigest(current),
    migrationState: "reverse-validated",
    activeStore: "v2",
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

export function advanceConversationStoreRestoreManifestToActive(
  current: ConversationStoreRestoreManifest,
  input: {
    commitId: string;
    proof: RecordMigrationValidationProof;
    activatedAt: number;
  }
): ConversationStoreRestoreManifest {
  validateConversationStoreRestoreManifest(current);
  if (current.migrationState !== "reverse-validated") {
    throw restoreError(
      "invalid-transition",
      "Conversation restore manifest must enter active from validated"
    );
  }
  assertReverseProof(current, input.proof);
  if (
    input.proof.report.targetFingerprint
    !== current.targetFingerprint
  ) {
    throw restoreError(
      "invalid-transition",
      "Conversation restore target fingerprint changed before activation"
    );
  }
  return finalizeRestoreManifest({
    ...restoreManifestWithoutDigest(current),
    migrationState: "reverse-active",
    activeStore: "v1",
    revision: current.revision + 1,
    commitId: input.commitId,
    previousRevision: current.revision,
    previousCommitId: current.commitId,
    previousDigest: current.digest,
    updatedAt: input.activatedAt,
    activatedAt: input.activatedAt
  });
}

export function validateConversationStoreRestoreManifest(
  value: unknown
): ConversationStoreRestoreManifest {
  const record = requireRecord(
    value,
    "Conversation Store restore manifest"
  );
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "migrationState",
    "activeStore",
    "sourceStore",
    "targetStore",
    "sourceManifestDigest",
    "sourceFingerprint",
    "targetFingerprint",
    "generationId",
    "planDigest",
    "revision",
    "commitId",
    "previousRevision",
    "previousCommitId",
    "previousDigest",
    "createdAt",
    "updatedAt",
    "activatedAt",
    "digest"
  ], "Conversation Store restore manifest");
  assertSchemaVersion(record.schemaVersion);
  if (record.recordType !== "conversation-store-v1-restore-manifest") {
    throw restoreError(
      "invalid-value",
      "Conversation Store restore recordType is invalid"
    );
  }
  if (
    record.migrationState !== "reverse-copying"
    && record.migrationState !== "reverse-validated"
    && record.migrationState !== "reverse-active"
  ) {
    throw restoreError(
      "invalid-value",
      "Conversation Store restore state is invalid"
    );
  }
  if (record.activeStore !== "v1" && record.activeStore !== "v2") {
    throw restoreError(
      "invalid-value",
      "Conversation Store restore activeStore is invalid"
    );
  }
  if (record.sourceStore !== "v2" || record.targetStore !== "v1") {
    throw restoreError(
      "invalid-value",
      "Conversation Store restore direction is invalid"
    );
  }
  requireDigest(record.sourceManifestDigest, "sourceManifestDigest");
  requireDigest(record.sourceFingerprint, "sourceFingerprint");
  if (record.targetFingerprint !== null) {
    requireDigest(record.targetFingerprint, "targetFingerprint");
  }
  if (typeof record.generationId !== "string") {
    throw restoreError("invalid-value", "restore generationId is invalid");
  }
  try {
    assertConversationStoreV1ExportGenerationId(record.generationId);
  } catch {
    throw restoreError("invalid-value", "restore generationId is invalid");
  }
  requireDigest(record.planDigest, "planDigest");
  requireNonNegativeInteger(record.revision, "revision");
  requireIdentifier(record.commitId, "commitId");
  validateNullableNonNegativeInteger(
    record.previousRevision,
    "previousRevision"
  );
  validateNullableIdentifier(record.previousCommitId, "previousCommitId");
  validateNullableDigest(record.previousDigest, "previousDigest");
  requireTimestamp(record.createdAt, "createdAt");
  requireTimestamp(record.updatedAt, "updatedAt");
  validateNullableTimestamp(record.activatedAt, "activatedAt");
  requireDigest(record.digest, "digest");
  if ((record.updatedAt as number) < (record.createdAt as number)) {
    throw restoreError(
      "invalid-value",
      "restore manifest updatedAt precedes createdAt"
    );
  }
  assertRestoreManifestStateShape(record);
  const { digest, ...withoutDigest } = record;
  if (digest !== digestRecord(withoutDigest)) {
    throw restoreError(
      "corrupt-chain",
      "Conversation Store restore manifest digest mismatch"
    );
  }
  return record as unknown as ConversationStoreRestoreManifest;
}

export class FileConversationStoreRestoreManifest {
  readonly storageRootPath: string;
  readonly manifestRootPath: string;
  readonly stagingRootPath: string;
  readonly activeFencePath: string;
  private readonly faultInjector:
    | FileConversationStoreRestoreManifestOptions["faultInjector"]
    | undefined;

  constructor(options: FileConversationStoreRestoreManifestOptions) {
    this.storageRootPath = path.resolve(options.storageRootPath);
    this.manifestRootPath = conversationStoreRestoreManifestRoot(
      this.storageRootPath
    );
    this.stagingRootPath = path.join(
      this.storageRootPath,
      RESTORE_STAGING_DIRECTORY
    );
    this.activeFencePath = path.join(
      this.storageRootPath,
      RESTORE_ACTIVE_FENCE_FILE
    );
    this.faultInjector = options.faultInjector;
  }

  async read(): Promise<ConversationStoreRestoreManifest | null> {
    const current = await readRestoreManifestChain(
      this.manifestRootPath,
      this.activeFencePath,
      true
    );
    if (current) await this.assertBinding(current);
    return current;
  }

  async compareAndSwap(
    candidateInput: ConversationStoreRestoreManifest,
    expectation: ConversationStoreRestoreManifestCasExpectation
  ): Promise<ConversationStoreRestoreManifest> {
    const candidate = validateConversationStoreRestoreManifest(
      candidateInput
    );
    const current = await this.read();
    await this.assertBinding(candidate);
    await ensureRestoreManifestLayout(this);
    assertExpectation(current, expectation);
    assertRestoreManifestTransition(current, candidate);
    if (candidate.migrationState === "reverse-active") {
      await publishRestoreActiveFence(this, candidate);
      await this.faultInjector?.(
        "after-restore-active-fence",
        candidate
      );
    }

    const stagedPath = path.join(
      this.stagingRootPath,
      `.restore-${entryFileName(candidate.revision)}-${randomUUID()}.tmp`
    );
    const targetPath = path.join(
      this.manifestRootPath,
      entryFileName(candidate.revision)
    );
    const bytes = Buffer.from(
      `${JSON.stringify(candidate, null, 2)}\n`,
      "utf8"
    );
    let staged = false;
    try {
      await writeNewFileDurably(stagedPath, bytes);
      staged = true;
      await syncDirectory(this.stagingRootPath);
      try {
        await fsp.link(stagedPath, targetPath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw restoreError(
            "revision-conflict",
            `Conversation restore revision ${candidate.revision} already has a winner`
          );
        }
        throw error;
      }
      await syncDirectory(this.manifestRootPath);
      const readback = await readRestoreManifestChain(
        this.manifestRootPath,
        this.activeFencePath
      );
      if (
        !readback
        || readback.revision !== candidate.revision
        || readback.commitId !== candidate.commitId
        || readback.digest !== candidate.digest
      ) {
        throw restoreError(
          "revision-conflict",
          "Conversation restore manifest readback differs from CAS winner"
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
  Promise<ConversationStoreRestoreManifest | null> {
    const current = await readRestoreManifestChain(
      this.manifestRootPath,
      this.activeFencePath,
      true
    );
    const fence = await readRestoreActiveFenceOrNull(
      this.activeFencePath
    );
    if (!fence || current?.migrationState === "reverse-active") {
      return null;
    }
    if (!current || current.migrationState !== "reverse-validated") {
      throw restoreError(
        "corrupt-chain",
        "restore active fence lacks validated predecessor"
      );
    }
    assertRestoreManifestTransition(current, fence.manifest);
    await this.assertBinding(fence.manifest);
    return fence.manifest;
  }

  async recoverPendingActiveCutover():
  Promise<ConversationStoreRestoreManifest | null> {
    const pending = await this.readPendingActiveCutover();
    if (!pending) return await this.read();
    const current = await readRestoreManifestChain(
      this.manifestRootPath,
      this.activeFencePath,
      true
    );
    if (!current || current.migrationState !== "reverse-validated") {
      throw restoreError(
        "corrupt-chain",
        "restore cutover recovery lacks validated predecessor"
      );
    }
    return await this.compareAndSwap(pending, {
      expectedRevision: current.revision,
      expectedCommitId: current.commitId
    });
  }

  private async assertBinding(
    manifest: ConversationStoreRestoreManifest
  ): Promise<void> {
    const forward = await new FileConversationStoreManifest({
      storageRootPath: this.storageRootPath
    }).read();
    if (
      !forward
      || forward.migrationState !== "active"
      || forward.activeStore !== "v2"
      || forward.digest !== manifest.sourceManifestDigest
    ) {
      throw restoreError(
        "source-not-active",
        "Conversation restore source is not the expected active V2 manifest"
      );
    }
    await assertExportPlanBinding(
      this.storageRootPath,
      manifest,
      forward
    );
  }
}

async function assertExportPlanBinding(
  storageRootPath: string,
  manifest: ConversationStoreRestoreManifest,
  forward: ConversationStoreManifest
): Promise<void> {
  await assertConversationStoreV1ExportDirectoryChain(
    storageRootPath,
    manifest.generationId,
    { requireStore: true }
  ).catch((error) => {
    throw restoreError(
      "unsafe-entry",
      `Conversation restore export directory chain is unsafe: ${
        errorMessage(error)
      }`
    );
  });
  const generationRootPath = conversationStoreV1ExportGenerationRoot(
    storageRootPath,
    manifest.generationId
  );
  const rootStat = await fsp.lstat(generationRootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw restoreError(
      "unsafe-entry",
      "Conversation restore export generation is unsafe"
    );
  }
  const plan = requireRecord(
    await readJsonFileSafely(
      path.join(generationRootPath, EXPORT_PLAN_FILE),
      "Conversation V1 export plan",
      [1]
    ),
    "Conversation V1 export plan"
  );
  assertExactKeys(plan, [
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
    plan.schemaVersion !== 1
    || plan.recordType !== "conversation-store-v1-export-plan"
    || plan.projection !== "conversation-portable-v1"
    || plan.generationId !== manifest.generationId
    || plan.sourceStoreVersion !== "v2"
    || plan.targetStoreVersion !== "v1"
    || plan.sourceManifestDigest !== forward.digest
    || plan.sourceManifestDigest !== manifest.sourceManifestDigest
    || plan.sourceFingerprint !== manifest.sourceFingerprint
    || plan.digest !== manifest.planDigest
  ) {
    throw restoreError(
      "corrupt-chain",
      "Conversation restore export plan binding is invalid"
    );
  }
  requireDigest(plan.sourceManifestDigest, "plan sourceManifestDigest");
  requireDigest(plan.sourceFingerprint, "plan sourceFingerprint");
  requireDigest(plan.digest, "plan digest");
  const { digest, ...draft } = plan;
  if (digest !== digestRecord(draft)) {
    throw restoreError(
      "corrupt-chain",
      "Conversation restore export plan digest is invalid"
    );
  }
}

async function readRestoreManifestChain(
  manifestRootPath: string,
  activeFencePath: string,
  allowPendingActiveFence = false
): Promise<ConversationStoreRestoreManifest | null> {
  const activeFence = await readRestoreActiveFenceOrNull(activeFencePath);
  const rootStat = await lstatOrNull(manifestRootPath);
  if (!rootStat) {
    if (activeFence) {
      throw restoreError(
        "corrupt-chain",
        "restore active fence exists without manifest chain"
      );
    }
    return null;
  }
  assertPlainDirectory(rootStat, "Conversation restore manifest root");
  const entries = await fsp.readdir(
    manifestRootPath,
    { withFileTypes: true }
  );
  if (!entries.length) {
    if (activeFence) {
      throw restoreError(
        "corrupt-chain",
        "restore active fence exists without manifest entries"
      );
    }
    return null;
  }
  const ordered = entries.map((entry) => {
    const match = ENTRY_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw restoreError(
        "unsafe-entry",
        `Conversation restore manifest has unsafe entry: ${entry.name}`
      );
    }
    return {
      name: entry.name,
      revision: Number(match[1])
    };
  }).sort((left, right) => left.revision - right.revision);

  let current: ConversationStoreRestoreManifest | null = null;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (
      entry.revision !== index
      || entry.name !== entryFileName(index)
    ) {
      throw restoreError(
        "corrupt-chain",
        "Conversation restore manifest revision chain is discontinuous"
      );
    }
    const candidate = validateConversationStoreRestoreManifest(
      await readJsonFileSafely(
        path.join(manifestRootPath, entry.name),
        "Conversation restore manifest entry",
        [1, 2]
      )
    );
    if (candidate.revision !== entry.revision) {
      throw restoreError(
        "corrupt-chain",
        "Conversation restore revision differs from filename"
      );
    }
    assertRestoreManifestTransition(current, candidate);
    current = candidate;
  }
  if (activeFence) {
    const matchesCurrent = current?.migrationState === "reverse-active"
      && activeFence.manifest.revision === current.revision
      && activeFence.manifest.commitId === current.commitId
      && activeFence.manifest.digest === current.digest;
    let isPending = false;
    if (
      allowPendingActiveFence
      && current?.migrationState === "reverse-validated"
    ) {
      try {
        assertRestoreManifestTransition(
          current,
          activeFence.manifest
        );
        isPending = true;
      } catch {
        isPending = false;
      }
    }
    if (!matchesCurrent && !isPending) {
      throw restoreError(
        "corrupt-chain",
        "restore active fence differs from manifest chain"
      );
    }
  } else if (current?.migrationState === "reverse-active") {
    throw restoreError(
      "corrupt-chain",
      "active restore manifest lacks irreversible fence"
    );
  }
  return current;
}

interface ConversationStoreRestoreActiveFence {
  schemaVersion: 1;
  recordType: "conversation-store-v1-restore-active-fence";
  manifest: ConversationStoreRestoreManifest;
}

async function publishRestoreActiveFence(
  store: FileConversationStoreRestoreManifest,
  manifest: ConversationStoreRestoreManifest
): Promise<void> {
  const fence: ConversationStoreRestoreActiveFence = {
    schemaVersion: 1,
    recordType: "conversation-store-v1-restore-active-fence",
    manifest
  };
  const bytes = Buffer.from(`${JSON.stringify(fence, null, 2)}\n`, "utf8");
  try {
    await writeNewFileDurably(store.activeFencePath, bytes);
    await syncDirectory(store.storageRootPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readRestoreActiveFenceOrNull(
      store.activeFencePath
    );
    if (
      !existing
      || existing.manifest.revision !== manifest.revision
      || existing.manifest.commitId !== manifest.commitId
      || existing.manifest.digest !== manifest.digest
    ) {
      throw restoreError(
        "revision-conflict",
        "restore active fence already has another winner"
      );
    }
  }
}

async function readRestoreActiveFenceOrNull(
  activeFencePath: string
): Promise<ConversationStoreRestoreActiveFence | null> {
  if (!await lstatOrNull(activeFencePath)) return null;
  const record = requireRecord(
    await readJsonFileSafely(
      activeFencePath,
      "Conversation restore active fence",
      [1]
    ),
    "Conversation restore active fence"
  );
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "manifest"
  ], "Conversation restore active fence");
  if (
    record.schemaVersion !== 1
    || record.recordType
      !== "conversation-store-v1-restore-active-fence"
  ) {
    throw restoreError(
      "corrupt-chain",
      "Conversation restore active fence is invalid"
    );
  }
  const manifest = validateConversationStoreRestoreManifest(
    record.manifest
  );
  if (
    manifest.migrationState !== "reverse-active"
    || manifest.activeStore !== "v1"
  ) {
    throw restoreError(
      "corrupt-chain",
      "Conversation restore fence does not bind active V1"
    );
  }
  return {
    schemaVersion: 1,
    recordType: "conversation-store-v1-restore-active-fence",
    manifest
  };
}

function assertReverseProof(
  manifest: ConversationStoreRestoreManifest,
  proof: RecordMigrationValidationProof
): void {
  assertRecordMigrationValidationProof(proof, {
    domain: "conversation",
    projection: "conversation-portable-v1",
    sourceStoreVersion: "v2",
    targetStoreVersion: "v1",
    sourceFingerprint: manifest.sourceFingerprint,
    targetFingerprint: proof.report.targetFingerprint
  });
}

function assertRestoreManifestTransition(
  current: ConversationStoreRestoreManifest | null,
  candidate: ConversationStoreRestoreManifest
): void {
  if (!current) {
    if (
      candidate.revision !== 0
      || candidate.migrationState !== "reverse-copying"
      || candidate.previousRevision !== null
      || candidate.previousCommitId !== null
      || candidate.previousDigest !== null
    ) {
      throw restoreError(
        "invalid-transition",
        "Conversation restore manifest must start at copying revision 0"
      );
    }
    return;
  }
  if (current.migrationState === "reverse-active") {
    throw restoreError(
      "invalid-transition",
      "Conversation restore manifest is terminal after activation"
    );
  }
  if (
    candidate.revision !== current.revision + 1
    || candidate.previousRevision !== current.revision
    || candidate.previousCommitId !== current.commitId
    || candidate.previousDigest !== current.digest
    || candidate.createdAt !== current.createdAt
    || candidate.sourceManifestDigest !== current.sourceManifestDigest
    || candidate.sourceFingerprint !== current.sourceFingerprint
    || candidate.generationId !== current.generationId
    || candidate.planDigest !== current.planDigest
  ) {
    throw restoreError(
      "invalid-transition",
      "Conversation restore manifest chain linkage is invalid"
    );
  }
  if (candidate.updatedAt < current.updatedAt) {
    throw restoreError(
      "invalid-transition",
      "Conversation restore updatedAt cannot move backward"
    );
  }
  if (
    (
      current.migrationState === "reverse-copying"
      && candidate.migrationState !== "reverse-validated"
    )
    || (
      current.migrationState === "reverse-validated"
      && candidate.migrationState !== "reverse-active"
    )
  ) {
    throw restoreError(
      "invalid-transition",
      "Conversation restore must advance copying -> validated -> active"
    );
  }
  if (
    current.targetFingerprint !== null
    && candidate.targetFingerprint !== current.targetFingerprint
  ) {
    throw restoreError(
      "invalid-transition",
      "Conversation restore target fingerprint cannot change"
    );
  }
}

function assertRestoreManifestStateShape(
  record: Record<string, unknown>
): void {
  if (record.migrationState === "reverse-copying") {
    if (
      record.activeStore !== "v2"
      || record.targetFingerprint !== null
      || record.activatedAt !== null
    ) {
      throw restoreError(
        "invalid-value",
        "reverse-copying manifest state is inconsistent"
      );
    }
    return;
  }
  if (record.migrationState === "reverse-validated") {
    if (
      record.activeStore !== "v2"
      || record.targetFingerprint === null
      || record.activatedAt !== null
    ) {
      throw restoreError(
        "invalid-value",
        "reverse-validated manifest state is inconsistent"
      );
    }
    return;
  }
  if (
    record.activeStore !== "v1"
    || record.targetFingerprint === null
    || record.activatedAt === null
  ) {
    throw restoreError(
      "invalid-value",
      "reverse-active manifest state is inconsistent"
    );
  }
}

function assertExpectation(
  current: ConversationStoreRestoreManifest | null,
  expectation: ConversationStoreRestoreManifestCasExpectation
): void {
  if (
    (current?.revision ?? null) !== expectation.expectedRevision
    || (current?.commitId ?? null) !== expectation.expectedCommitId
  ) {
    throw restoreError(
      "revision-conflict",
      "Conversation restore manifest CAS expectation is stale"
    );
  }
}

async function ensureRestoreManifestLayout(
  store: FileConversationStoreRestoreManifest
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
  assertPlainDirectory(await fsp.lstat(absolutePath), absolutePath);
}

function assertPlainDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw restoreError(
      "unsafe-entry",
      `${label} must be a plain directory`
    );
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
    throw restoreError(
      "unsafe-entry",
      `${label} cannot be opened safely: ${errorMessage(error)}`
    );
  });
  try {
    const before = await handle.stat();
    assertSafeRegularFile(before, label, allowedLinkCounts);
    if (before.size > MAX_RECORD_BYTES) {
      throw restoreError(
        "unsafe-entry",
        `${label} exceeds the safety size limit`
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileVersion(before, after) || bytes.byteLength !== before.size) {
      throw restoreError(
        "unsafe-entry",
        `${label} changed during read`
      );
    }
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw restoreError(
        "corrupt-chain",
        `${label} is invalid JSON: ${errorMessage(error)}`
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
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw restoreError(
      "invalid-value",
      "Conversation restore manifest exceeds the safety size limit"
    );
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
      "new Conversation restore manifest entry",
      [1]
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
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
    throw restoreError(
      "unsafe-entry",
      `${label} must be a safe regular file`
    );
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
    throw restoreError("invalid-value", "restore revision is invalid");
  }
  const digits = String(revision);
  if (digits.length > ENTRY_WIDTH) {
    throw restoreError(
      "invalid-value",
      "restore revision exceeds the filename limit"
    );
  }
  return `${ENTRY_PREFIX}${digits.padStart(ENTRY_WIDTH, "0")}.json`;
}

function finalizeRestoreManifest(
  value: Omit<ConversationStoreRestoreManifest, "digest">
): ConversationStoreRestoreManifest {
  const manifest = {
    ...value,
    digest: digestRecord(value)
  };
  validateConversationStoreRestoreManifest(manifest);
  return manifest;
}

function restoreManifestWithoutDigest(
  value: ConversationStoreRestoreManifest
): Omit<ConversationStoreRestoreManifest, "digest"> {
  const { digest: _digest, ...withoutDigest } = value;
  return withoutDigest;
}

function digestRecord(value: unknown): string {
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
  const record = requireRecord(value, "restore canonical JSON");
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
    throw restoreError("invalid-record", `${label} must be a plain object`);
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
      throw restoreError(
        "unexpected-field",
        `${label} has unexpected field ${key}`
      );
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw restoreError(
        "missing-field",
        `${label} is missing field ${key}`
      );
    }
  }
}

function assertSchemaVersion(value: unknown): void {
  if (value === RESTORE_MANIFEST_SCHEMA_VERSION) return;
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value > RESTORE_MANIFEST_SCHEMA_VERSION
  ) {
    throw restoreError(
      "future-schema",
      `future restore manifest schema: ${value}`
    );
  }
  throw restoreError(
    "unknown-schema",
    "restore manifest schemaVersion is unknown"
  );
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value.length
    || value.trim() !== value
    || value.length > 512
    || hasUnsafeControlCharacter(value)
  ) {
    throw restoreError("invalid-value", `restore ${label} is invalid`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw restoreError("invalid-value", `restore ${label} is invalid`);
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

function validateNullableNonNegativeInteger(
  value: unknown,
  label: string
): void {
  if (value !== null) requireNonNegativeInteger(value, label);
}

function validateNullableTimestamp(value: unknown, label: string): void {
  if (value !== null) requireTimestamp(value, label);
}

function requireTimestamp(value: unknown, label: string): number {
  return requireNonNegativeInteger(value, label);
}

function requireNonNegativeInteger(
  value: unknown,
  label: string
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw restoreError("invalid-value", `restore ${label} is invalid`);
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

function restoreError(
  code: ConversationStoreRestoreManifestErrorCode,
  message: string
): ConversationStoreRestoreManifestError {
  return new ConversationStoreRestoreManifestError(code, message);
}
