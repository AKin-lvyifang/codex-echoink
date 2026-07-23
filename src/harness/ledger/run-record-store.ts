import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  RUN_RECORD_REASON_CODES,
  RUN_RECORD_MAX_PAYLOAD_BYTES,
  canonicalRunRecordDigest,
  runRecordSubjectDigest,
  safeRunRecordToken,
  serializeAttemptPayloadEvents,
  validateAttemptPayloadRetirementReceipt,
  validateAttemptHarnessEvent,
  validateAttemptPayloadManifest,
  validateAttemptRunSummary,
  validateRetentionTombstone,
  validateWorkflowRunSummary,
  type AttemptHarnessEventV1,
  type AttemptPayloadRetirementReceiptV1,
  type AttemptPayloadManifestV1,
  type AttemptRunSummaryV1,
  type RunRecordReasonCode,
  type RunRetentionTombstoneV1,
  type WorkflowRunSummaryV1
} from "../contracts/run-record";

export const RUN_RECORD_STORE_DIRECTORY = "harness-run-records-v1";

export type RunRecordStoreFaultPoint =
  | "after-generation-sync"
  | "after-manifest-link"
  | "after-manifest-publish";

export type RunRecordStoreFaultInjector = (
  point: RunRecordStoreFaultPoint
) => void | Promise<void>;

export interface RunRecordStoreCas {
  expectedRevision: number | null;
  expectedDigest: string | null;
}

export interface AttemptRunRecordLocator {
  workflowRunId: string;
  attemptId: string;
}

export type RunRecordStoreReadResult<T> =
  | { state: "present"; record: T }
  | {
      state: "expired";
      tombstone: RunRetentionTombstoneV1;
      priorRecord: T;
    }
  | { state: "missing" }
  | { state: "corrupt"; code: RunRecordStoreCorruptCode; error: string };

export type AttemptPayloadReadResult =
  | {
      state: "present";
      manifest: AttemptPayloadManifestV1;
      events: AttemptHarnessEventV1[];
    }
  | {
      state: "expired";
      tombstone: RunRetentionTombstoneV1;
      retirementReceipt?: AttemptPayloadRetirementReceiptV1;
    }
  | {
      state: "not-captured";
      reasonCode: RunRecordReasonCode;
    }
  | { state: "missing" }
  | { state: "corrupt"; code: RunRecordStoreCorruptCode; error: string };

type AttemptPayloadRetirementReadEvidence =
  | {
      state: "expired";
      tombstone: RunRetentionTombstoneV1;
      retirementReceipt: AttemptPayloadRetirementReceiptV1;
    }
  | {
      state: "corrupt";
      code: RunRecordStoreCorruptCode;
      error: string;
    };

export interface AttemptPayloadUserDeletionProbe
extends AttemptRunRecordLocator {
  forwardEffectId: string;
}

export type AttemptPayloadUserDeletionObservation =
  | {
      status: "before";
      manifest: AttemptPayloadManifestV1;
    }
  | {
      status: "source-deleted";
      tombstone: RunRetentionTombstoneV1;
    }
  | {
      status: "source-restored";
      tombstone: RunRetentionTombstoneV1;
      restoredManifest: AttemptPayloadManifestV1;
      restoredAt: number;
    };

export type AttemptPayloadRetirementCandidate =
  | {
      status: "eligible";
      manifest: AttemptPayloadManifestV1;
      priorGeneration: string;
      priorGenerationManifestDigest: string;
      sourceRelativePath: string;
    }
  | {
      status: "retired";
      tombstone: RunRetentionTombstoneV1;
      retirementReceipt: AttemptPayloadRetirementReceiptV1;
    };

export type RunRecordStoreCorruptCode =
  | "unsafe-path"
  | "manifest-corrupt"
  | "generation-missing"
  | "record-corrupt"
  | "payload-manifest-corrupt"
  | "payload-jsonl-corrupt"
  | "payload-digest-mismatch"
  | "payload-event-invalid"
  | "tombstone-corrupt"
  | "retirement-receipt-corrupt"
  | "not-captured-corrupt";

export class RunRecordStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRecordStoreConflictError";
  }
}

export class RunRecordStoreCorruptError extends Error {
  constructor(
    public readonly code: RunRecordStoreCorruptCode,
    message: string
  ) {
    super(message);
    this.name = "RunRecordStoreCorruptError";
  }
}

export class RunRecordStoreSimulatedCrash extends Error {
  constructor(message = "simulated run record store crash") {
    super(message);
    this.name = "RunRecordStoreSimulatedCrash";
  }
}

export interface FileRunRecordStoreOptions {
  storageRootPath: string;
}

export interface MarkAttemptPayloadNotCapturedInput {
  workflowRunId: string;
  attemptId: string;
  harnessRunId: string;
  reasonCode:
    | "failed-before-payload"
    | "capture-disabled"
    | "no-attempt-required";
  recordedAt: number;
  revision: number;
}

export type ConversationRunRecordInventoryBlockerCode =
  | "attempt-ordinal-mismatch"
  | "attempt-payload-harness-mismatch"
  | "missing-attempt-payload"
  | "missing-attempt-summary"
  | "payload-state-mismatch"
  | "unexpected-attempt-payload"
  | "unexpected-attempt-summary";

export interface ConversationRunRecordInventoryBlocker {
  code: ConversationRunRecordInventoryBlockerCode;
  workflowRunId: string;
  attemptId: string;
  recordDigest?: string;
}

export type ConversationAttemptPayloadInventory =
  | {
      state: "present";
      manifest: AttemptPayloadManifestV1;
      rawRefs: string[];
      sourceRelativePath: string;
    }
  | {
      state: "expired";
      tombstone: RunRetentionTombstoneV1;
    }
  | {
      state: "not-captured";
      reasonCode: RunRecordReasonCode;
    }
  | { state: "missing" };

export interface ConversationAttemptRunInventory {
  attemptId: string;
  ordinal: number;
  summary: AttemptRunSummaryV1 | null;
  summaryTombstone?: RunRetentionTombstoneV1;
  payload: ConversationAttemptPayloadInventory;
}

export interface ConversationWorkflowRunInventory {
  summary: WorkflowRunSummaryV1;
  summaryTombstone?: RunRetentionTombstoneV1;
  attempts: ConversationAttemptRunInventory[];
}

export interface ConversationRunRecordInventory {
  conversationId: string;
  workflowRuns: ConversationWorkflowRunInventory[];
  storeRawOwners: Array<{
    rawRef: string;
    workflowRunId: string;
    attemptId: string;
    conversationId?: string;
  }>;
  blockers: ConversationRunRecordInventoryBlocker[];
  snapshotDigest: string;
}

export interface RunRecordStoreInventory {
  workflowRuns: ConversationWorkflowRunInventory[];
  storeRawOwners: ConversationRunRecordInventory["storeRawOwners"];
  blockers: ConversationRunRecordInventoryBlocker[];
  snapshotDigest: string;
}

type RunRecordStoreRecordKind =
  | "workflow-summary"
  | "attempt-summary"
  | "attempt-payload";

type RunRecordStoreContentKind =
  | "record"
  | "payload"
  | "not-captured"
  | "expired"
  | "retired";

interface RunRecordGenerationManifest {
  schemaVersion: 1;
  recordType: "run-record-generation-manifest";
  recordKind: RunRecordStoreRecordKind;
  subjectToken: string;
  revision: number;
  generation: string;
  contentKind: RunRecordStoreContentKind;
  contentDigest: string;
  previousContentDigest: string | null;
  committedAt: number;
  digest: string;
}

interface RunRecordHeadV1 {
  schemaVersion: 1;
  recordType: "run-record-head";
  recordKind: RunRecordStoreRecordKind;
  subjectToken: string;
  revision: number;
  manifestDigest: string;
}

interface AttemptPayloadNotCapturedRecord {
  schemaVersion: 1;
  recordType: "attempt-payload-not-captured";
  workflowRunId: string;
  attemptId: string;
  harnessRunId: string;
  subjectDigest: string;
  reasonCode:
    | "failed-before-payload"
    | "capture-disabled"
    | "no-attempt-required";
  recordedAt: number;
  revision: number;
  digest: string;
}

interface SubjectLayout {
  subjectRootPath: string;
  generationsPath: string;
  manifestsPath: string;
  headPath: string;
}

interface RunRecordStoreInventorySnapshot {
  workflowRunIds: string[];
  attemptLocators: AttemptRunRecordLocator[];
  payloadLocators: AttemptRunRecordLocator[];
  activeHeads: Array<{
    recordKind: RunRecordStoreRecordKind;
    subjectToken: string;
    manifestDigest: string;
    generation: string;
    contentKind: RunRecordStoreContentKind;
  }>;
  digest: string;
}

type LatestManifestResult =
  | {
      state: "missing";
      layout: SubjectLayout;
      orphan?: RunRecordGenerationManifest;
    }
  | {
      state: "present";
      layout: SubjectLayout;
      manifest: RunRecordGenerationManifest;
      chain: RunRecordGenerationManifest[];
      orphan?: RunRecordGenerationManifest;
    }
  | {
      state: "corrupt";
      layout: SubjectLayout;
      code: RunRecordStoreCorruptCode;
      error: string;
    };

interface PublishGenerationInput {
  recordKind: RunRecordStoreRecordKind;
  subjectId: string;
  revision: number;
  contentKind: RunRecordStoreContentKind;
  contentDigest: string;
  cas: RunRecordStoreCas;
  files: readonly {
    relativePath: string;
    content: string;
  }[];
  faultInjector?: RunRecordStoreFaultInjector;
  allowedPreviousContentKinds: readonly (RunRecordStoreContentKind | null)[];
  committedAt?: number;
}

const MANIFEST_FILE_PATTERN = /^(\d{12})\.json$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CAPTURE_REASON_CODES = new Set<RunRecordReasonCode>([
  "failed-before-payload",
  "capture-disabled",
  "no-attempt-required"
]);
const runRecordStoreMutationContext = new AsyncLocalStorage<string>();
const runRecordStoreMutationTails = new Map<string, Promise<void>>();

/**
 * Attempts are only unique inside a Workflow Run. Keep the compound identity
 * in the storage locator so two workflows may safely reuse the same attemptId.
 */
export function attemptRunRecordSubjectToken(
  locator: AttemptRunRecordLocator
): string {
  return safeRunRecordToken(attemptRecordSubjectId(locator));
}

/**
 * Side-by-side V1 Run Record Store.
 *
 * It never reads or mutates the legacy `harness-runs` directory. Every update
 * publishes an immutable generation, then a no-clobber append-only manifest.
 * The Store never directly deletes a payload generation. The retention
 * authority may retire a prior generation through recoverable Trash, then
 * publish the exact retirement receipt as a new immutable generation.
 */
export class FileRunRecordStore {
  readonly rootPath: string;

  constructor(options: FileRunRecordStoreOptions) {
    this.rootPath = path.join(
      path.resolve(options.storageRootPath),
      RUN_RECORD_STORE_DIRECTORY
    );
  }

  async ensureInitialized(): Promise<void> {
    const existing = await lstatOrNull(this.rootPath);
    if (!existing) await mkdir(this.rootPath, { recursive: true });
    const stats = await lstat(this.rootPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new RunRecordStoreCorruptError(
        "unsafe-path",
        "Run Record Store root is not a plain directory"
      );
    }
    for (const directory of [
      ".staging",
      "attempt-payloads",
      "attempt-summaries",
      "workflow-summaries"
    ]) {
      const target = path.join(this.rootPath, directory);
      const current = await lstatOrNull(target);
      if (!current) await mkdir(target);
      const directoryStats = await lstat(target);
      if (
        !directoryStats.isDirectory()
        || directoryStats.isSymbolicLink()
      ) {
        throw new RunRecordStoreCorruptError(
          "unsafe-path",
          "Run Record Store collection is not a plain directory"
        );
      }
    }
  }

  /**
   * Serializes a multi-record mutation with every generation publication for
   * this Store root. Nested calls in the same async flow reuse the authority;
   * unrelated concurrent callers still queue behind it.
   */
  async withMutation<T>(action: () => Promise<T>): Promise<T> {
    if (runRecordStoreMutationContext.getStore() === this.rootPath) {
      return await action();
    }
    return await enqueueRunRecordStoreMutation(this.rootPath, async () =>
      await runRecordStoreMutationContext.run(this.rootPath, action)
    );
  }

  async writeWorkflowRunSummary(
    summary: WorkflowRunSummaryV1,
    cas: RunRecordStoreCas,
    faultInjector?: RunRecordStoreFaultInjector
  ): Promise<void> {
    const record = validateWorkflowRunSummary(summary);
    const current = await this.readWorkflowRunSummary(record.workflowRunId);
    assertReadableCurrent(current);
    if (current.state === "present") {
      assertWorkflowSummaryTransition(current.record, record);
    }
    await this.publishGeneration({
      recordKind: "workflow-summary",
      subjectId: record.workflowRunId,
      revision: record.revision,
      contentKind: "record",
      contentDigest: record.digest,
      cas,
      files: [{
        relativePath: "record.json",
        content: jsonLine(record)
      }],
      faultInjector,
      allowedPreviousContentKinds: [null, "record"]
    });
  }

  async readWorkflowRunSummary(
    workflowRunId: string
  ): Promise<RunRecordStoreReadResult<WorkflowRunSummaryV1>> {
    return await this.readSummary(
      "workflow-summary",
      "workflow-summary",
      workflowRunId,
      validateWorkflowRunSummary,
      (record) => record.workflowRunId === workflowRunId
    );
  }

  async writeAttemptRunSummary(
    summary: AttemptRunSummaryV1,
    cas: RunRecordStoreCas,
    faultInjector?: RunRecordStoreFaultInjector
  ): Promise<void> {
    const record = validateAttemptRunSummary(summary);
    const current = await this.readAttemptRunSummary(record);
    assertReadableCurrent(current);
    if (current.state === "present") {
      assertAttemptSummaryTransition(current.record, record);
    }
    await this.publishGeneration({
      recordKind: "attempt-summary",
      subjectId: attemptRecordSubjectId(record),
      revision: record.revision,
      contentKind: "record",
      contentDigest: record.digest,
      cas,
      files: [{
        relativePath: "record.json",
        content: jsonLine(record)
      }],
      faultInjector,
      allowedPreviousContentKinds: [null, "record"]
    });
  }

  async readAttemptRunSummary(
    locator: AttemptRunRecordLocator
  ): Promise<RunRecordStoreReadResult<AttemptRunSummaryV1>> {
    return await this.readSummary(
      "attempt-summary",
      "attempt-summary",
      attemptRecordSubjectId(locator),
      validateAttemptRunSummary,
      (record) =>
        record.workflowRunId === locator.workflowRunId
        && record.attemptId === locator.attemptId
    );
  }

  async publishWorkflowRunSummaryTombstone(
    tombstone: RunRetentionTombstoneV1,
    cas: RunRecordStoreCas,
    faultInjector?: RunRecordStoreFaultInjector
  ): Promise<void> {
    const record = validateRetentionTombstone(tombstone);
    if (
      record.scope !== "workflow-summary"
      || record.attemptId !== undefined
      || record.harnessRunId !== undefined
    ) {
      throw new RunRecordStoreConflictError(
        "Workflow summary tombstone has the wrong scope or identity"
      );
    }
    const current = await this.readWorkflowRunSummary(
      record.workflowRunId
    );
    const summary = current.state === "present"
      ? current.record
      : current.state === "expired"
        ? current.priorRecord
        : null;
    if (summary) {
      for (const reference of summary.attemptRefs) {
        const attempt = await this.readAttemptRunSummary({
          workflowRunId: summary.workflowRunId,
          attemptId: reference.attemptId
        });
        if (attempt.state !== "expired") {
          throw new RunRecordStoreConflictError(
            "Workflow summary retention requires every Attempt summary to be expired"
          );
        }
      }
    }
    await this.publishSummaryTombstone({
      recordKind: "workflow-summary",
      subjectId: record.workflowRunId,
      current,
      tombstone: record,
      cas,
      faultInjector
    });
  }

  async publishAttemptRunSummaryTombstone(
    tombstone: RunRetentionTombstoneV1,
    cas: RunRecordStoreCas,
    faultInjector?: RunRecordStoreFaultInjector
  ): Promise<void> {
    const record = validateRetentionTombstone(tombstone);
    if (
      record.scope !== "attempt-summary"
      || !record.attemptId
      || record.harnessRunId !== undefined
    ) {
      throw new RunRecordStoreConflictError(
        "Attempt summary tombstone has the wrong scope or identity"
      );
    }
    const locator = {
      workflowRunId: record.workflowRunId,
      attemptId: record.attemptId
    };
    const current = await this.readAttemptRunSummary(locator);
    const summary = current.state === "present"
      ? current.record
      : current.state === "expired"
        ? current.priorRecord
        : null;
    if (summary) {
      const payload = await this.readAttemptPayload(locator);
      const payloadSettled = summary.payload.expected
        ? payload.state === "expired"
          && (
            payload.tombstone.reasonCode === "user-deleted"
            || payload.retirementReceipt !== undefined
          )
        : payload.state === "not-captured";
      if (!payloadSettled) {
        throw new RunRecordStoreConflictError(
          "Attempt summary retention requires its payload to be physically retired or not-captured"
        );
      }
    }
    await this.publishSummaryTombstone({
      recordKind: "attempt-summary",
      subjectId: attemptRecordSubjectId(locator),
      current,
      tombstone: record,
      cas,
      faultInjector
    });
  }

  async sealAttemptPayload(
    manifest: AttemptPayloadManifestV1,
    events: readonly AttemptHarnessEventV1[],
    cas: RunRecordStoreCas,
    faultInjector?: RunRecordStoreFaultInjector
  ): Promise<void> {
    const record = validateAttemptPayloadManifest(manifest);
    const eventBytes = serializeAttemptPayloadEvents(
      events,
      {
        workflowRunId: record.workflowRunId,
        attemptId: record.attemptId,
        harnessRunId: record.harnessRunId
      }
    );
    if (
      Buffer.byteLength(eventBytes) !== record.byteCount
      || sha256(eventBytes) !== record.payloadSha256
      || events.length !== record.eventCount
    ) {
      throw new RunRecordStoreCorruptError(
        "payload-digest-mismatch",
        "Attempt payload bytes do not match the sealed manifest"
      );
    }
    await this.publishGeneration({
      recordKind: "attempt-payload",
      subjectId: attemptRecordSubjectId(record),
      revision: record.revision,
      contentKind: "payload",
      contentDigest: record.digest,
      cas,
      files: [
        {
          relativePath: "manifest.json",
          content: jsonLine(record)
        },
        {
          relativePath: "events.jsonl",
          content: eventBytes
        }
      ],
      faultInjector,
      allowedPreviousContentKinds: [null]
    });
  }

  async markAttemptPayloadNotCaptured(
    input: MarkAttemptPayloadNotCapturedInput,
    cas: RunRecordStoreCas,
    faultInjector?: RunRecordStoreFaultInjector
  ): Promise<void> {
    const record = validateNotCapturedRecord(withDigest({
      schemaVersion: 1,
      recordType: "attempt-payload-not-captured",
      workflowRunId: input.workflowRunId,
      attemptId: input.attemptId,
      harnessRunId: input.harnessRunId,
      subjectDigest: runRecordSubjectDigest(
        "attempt-payload",
        input.workflowRunId,
        input.attemptId,
        input.harnessRunId
      ),
      reasonCode: input.reasonCode,
      recordedAt: input.recordedAt,
      revision: input.revision
    }));
    await this.publishGeneration({
      recordKind: "attempt-payload",
      subjectId: attemptRecordSubjectId(record),
      revision: record.revision,
      contentKind: "not-captured",
      contentDigest: record.digest,
      cas,
      files: [{
        relativePath: "record.json",
        content: jsonLine(record)
      }],
      faultInjector,
      allowedPreviousContentKinds: [null]
    });
  }

  /**
   * Publishes an authoritative expired marker only over a verified, sealed
   * payload generation. The old immutable payload bytes remain untouched.
   */
  async publishAttemptPayloadTombstone(
    tombstone: RunRetentionTombstoneV1,
    cas: RunRecordStoreCas,
    faultInjector?: RunRecordStoreFaultInjector
  ): Promise<void> {
    const record = validateRetentionTombstone(tombstone);
    if (
      record.scope !== "attempt-payload"
      || !record.attemptId
      || !record.harnessRunId
    ) {
      throw new RunRecordStoreConflictError(
        "Attempt payload tombstone has the wrong scope or identity"
      );
    }
    const locator: AttemptRunRecordLocator = {
      workflowRunId: record.workflowRunId,
      attemptId: record.attemptId
    };
    const current = await this.readAttemptPayload(locator);
    if (current.state === "missing") {
      throw new RunRecordStoreConflictError(
        "Cannot publish expired tombstone for a missing payload"
      );
    }
    if (current.state === "corrupt") {
      throw new RunRecordStoreCorruptError(current.code, current.error);
    }
    if (current.state === "expired") {
      if (current.tombstone.digest === record.digest) return;
      throw new RunRecordStoreConflictError(
        "Attempt payload already has a different expired tombstone"
      );
    }
    if (current.state !== "present") {
      throw new RunRecordStoreConflictError(
        `Cannot publish expired tombstone over ${current.state}`
      );
    }
    const manifest = current.manifest;
    if (
      record.workflowRunId !== manifest.workflowRunId
      || record.attemptId !== manifest.attemptId
      || record.harnessRunId !== manifest.harnessRunId
      || record.subjectDigest !== manifest.subjectDigest
      || record.prior.digest !== manifest.digest
      || record.prior.eventCount !== manifest.eventCount
      || record.prior.byteCount !== manifest.byteCount
      || record.prior.terminalAt !== manifest.terminalAt
    ) {
      throw new RunRecordStoreConflictError(
        "Tombstone does not exactly describe the active sealed payload"
      );
    }
    await this.publishGeneration({
      recordKind: "attempt-payload",
      subjectId: attemptRecordSubjectId(locator),
      revision: record.revision,
      contentKind: "expired",
      contentDigest: record.digest,
      cas,
      files: [{
        relativePath: "record.json",
        content: jsonLine(record)
      }],
      faultInjector,
      allowedPreviousContentKinds: ["payload"]
    });
  }

  /**
   * Freezes the exact immutable payload generation that a retention
   * transaction may prepare in Trash. This probe is intentionally valid only
   * while the payload is still present; crash recovery after the tombstone
   * uses the transaction execution header instead of rediscovering identity.
   */
  async inspectAttemptPayloadRetirementCandidate(
    locator: AttemptRunRecordLocator
  ): Promise<AttemptPayloadRetirementCandidate> {
    const subjectId = attemptRecordSubjectId(locator);
    const latest = await this.readLatestManifest(
      "attempt-payload",
      subjectId
    );
    if (latest.state === "missing") {
      throw new RunRecordStoreConflictError(
        "Attempt payload retirement candidate is missing"
      );
    }
    if (latest.state === "corrupt") {
      throw new RunRecordStoreCorruptError(latest.code, latest.error);
    }
    if (latest.orphan) {
      throw new RunRecordStoreConflictError(
        "Attempt payload retirement candidate requires generation recovery"
      );
    }
    if (latest.manifest.contentKind === "retired") {
      const evidence = await this.readPayloadRetirementEvidence(
        locator,
        latest
      );
      if (evidence.state === "corrupt") {
        throw new RunRecordStoreCorruptError(
          evidence.code,
          evidence.error
        );
      }
      return {
        status: "retired",
        tombstone: evidence.tombstone,
        retirementReceipt: evidence.retirementReceipt
      };
    }
    if (latest.manifest.contentKind !== "payload") {
      throw new RunRecordStoreConflictError(
        `Attempt payload cannot freeze retirement identity from ${latest.manifest.contentKind}`
      );
    }
    const present = await this.readPresentPayload(
      locator,
      path.join(
        latest.layout.generationsPath,
        latest.manifest.generation
      ),
      latest.manifest
    );
    if (present.state === "corrupt") {
      throw new RunRecordStoreCorruptError(present.code, present.error);
    }
    if (present.state !== "present") {
      throw new RunRecordStoreConflictError(
        "Attempt payload retirement candidate is not present"
      );
    }
    return {
      status: "eligible",
      manifest: present.manifest,
      priorGeneration: latest.manifest.generation,
      priorGenerationManifestDigest: latest.manifest.digest,
      sourceRelativePath: path.posix.join(
        collectionDirectory("attempt-payload"),
        safeRunRecordToken(subjectId),
        "generations",
        latest.manifest.generation
      )
    };
  }

  /**
   * Publishes the authoritative proof that a policy-expired generation was
   * physically retired. The prior generation must already be absent from the
   * Run Store; the receipt binds the Trash prepare and finalization digests
   * that authorized that absence.
   */
  async publishAttemptPayloadRetirementReceipt(
    retirementReceipt: AttemptPayloadRetirementReceiptV1,
    cas: RunRecordStoreCas,
    faultInjector?: RunRecordStoreFaultInjector
  ): Promise<void> {
    const receipt = validateAttemptPayloadRetirementReceipt(
      retirementReceipt
    );
    const locator: AttemptRunRecordLocator = {
      workflowRunId: receipt.workflowRunId,
      attemptId: receipt.attemptId
    };
    const subjectId = attemptRecordSubjectId(locator);
    const latest = await this.readLatestManifest(
      "attempt-payload",
      subjectId
    );
    if (latest.state === "missing") {
      throw new RunRecordStoreConflictError(
        "Cannot publish retirement receipt for a missing payload record"
      );
    }
    if (latest.state === "corrupt") {
      throw new RunRecordStoreCorruptError(latest.code, latest.error);
    }
    if (latest.manifest.contentKind === "retired") {
      const evidence = await this.readPayloadRetirementEvidence(
        locator,
        latest
      );
      if (evidence.state === "corrupt") {
        throw new RunRecordStoreCorruptError(
          evidence.code,
          evidence.error
        );
      }
      if (evidence.retirementReceipt.digest === receipt.digest) return;
      throw new RunRecordStoreConflictError(
        "Attempt payload already has a different retirement receipt"
      );
    }
    if (latest.manifest.contentKind !== "expired" || latest.orphan) {
      throw new RunRecordStoreConflictError(
        "Attempt payload retirement receipt requires a committed tombstone"
      );
    }
    const tombstone = validateRetentionTombstone(
      await readJsonFile(path.join(
        latest.layout.generationsPath,
        latest.manifest.generation,
        "record.json"
      ))
    );
    const priorPointer = latest.chain.at(-2);
    if (
      tombstone.scope !== "attempt-payload"
      || tombstone.reasonCode !== "policy-expired"
      || tombstone.workflowRunId !== receipt.workflowRunId
      || tombstone.attemptId !== receipt.attemptId
      || tombstone.harnessRunId !== receipt.harnessRunId
      || tombstone.subjectDigest !== receipt.subjectDigest
      || tombstone.digest !== receipt.tombstoneDigest
      || tombstone.revision !== receipt.tombstoneRevision
      || tombstone.retentionTransactionId
        !== receipt.retentionTransactionId
      || latest.manifest.contentDigest !== tombstone.digest
      || !priorPointer
      || priorPointer.contentKind !== "payload"
      || priorPointer.generation !== receipt.priorGeneration
      || priorPointer.digest
        !== receipt.priorGenerationManifestDigest
      || priorPointer.contentDigest !== receipt.priorPayloadDigest
      || tombstone.prior.digest !== receipt.priorPayloadDigest
    ) {
      throw new RunRecordStoreConflictError(
        "Retirement receipt does not exactly bind the active payload tombstone"
      );
    }
    if (
      await lstatOrNull(path.join(
        latest.layout.generationsPath,
        priorPointer.generation
      ))
    ) {
      throw new RunRecordStoreConflictError(
        "Retirement receipt cannot publish while prior payload bytes remain active"
      );
    }
    await this.publishGeneration({
      recordKind: "attempt-payload",
      subjectId,
      revision: receipt.revision,
      contentKind: "retired",
      contentDigest: receipt.digest,
      cas,
      files: [{
        relativePath: "record.json",
        content: jsonLine(receipt)
      }],
      faultInjector,
      allowedPreviousContentKinds: ["expired"],
      committedAt: receipt.retiredAt
    });
  }

  async readAttemptPayload(
    locator: AttemptRunRecordLocator
  ): Promise<AttemptPayloadReadResult> {
    const latest = await this.readLatestManifest(
      "attempt-payload",
      attemptRecordSubjectId(locator)
    );
    if (latest.state === "missing") return { state: "missing" };
    if (latest.state === "corrupt") {
      return {
        state: "corrupt",
        code: latest.code,
        error: latest.error
      };
    }
    const generationPath = path.join(
      latest.layout.generationsPath,
      latest.manifest.generation
    );
    if (latest.manifest.contentKind === "payload") {
      return await this.readPresentPayload(
        locator,
        generationPath,
        latest.manifest
      );
    }
    if (latest.manifest.contentKind === "not-captured") {
      try {
        const record = validateNotCapturedRecord(
          await readJsonFile(path.join(generationPath, "record.json"))
        );
        if (
          record.workflowRunId !== locator.workflowRunId
          || record.attemptId !== locator.attemptId
          || record.revision !== latest.manifest.revision
          || record.digest !== latest.manifest.contentDigest
        ) {
          throw new Error("not-captured generation identity mismatch");
        }
        return {
          state: "not-captured",
          reasonCode: record.reasonCode
        };
      } catch (error) {
        return corruptResult("not-captured-corrupt", error);
      }
    }
    if (latest.manifest.contentKind === "expired") {
      try {
        const tombstone = validateRetentionTombstone(
          await readJsonFile(path.join(generationPath, "record.json"))
        );
        if (
          tombstone.scope !== "attempt-payload"
          || tombstone.workflowRunId !== locator.workflowRunId
          || tombstone.attemptId !== locator.attemptId
          || tombstone.revision !== latest.manifest.revision
          || tombstone.digest !== latest.manifest.contentDigest
        ) {
          throw new Error("expired generation identity mismatch");
        }
        const priorPointer = latest.chain.at(-2);
        if (
          !priorPointer
          || priorPointer.contentKind !== "payload"
          || priorPointer.contentDigest !== tombstone.prior.digest
        ) {
          throw new Error("expired generation lacks its sealed prior manifest");
        }
        if (tombstone.reasonCode !== "user-deleted") {
          const prior = await this.readPresentPayload(
            locator,
            path.join(latest.layout.generationsPath, priorPointer.generation),
            priorPointer
          );
          if (
            prior.state !== "present"
            || prior.manifest.eventCount !== tombstone.prior.eventCount
            || prior.manifest.byteCount !== tombstone.prior.byteCount
            || prior.manifest.terminalAt !== tombstone.prior.terminalAt
          ) {
            throw new Error(
              "expired generation cannot prove its sealed prior payload"
            );
          }
        }
        return { state: "expired", tombstone };
      } catch (error) {
        return corruptResult("tombstone-corrupt", error);
      }
    }
    if (latest.manifest.contentKind === "retired") {
      return await this.readPayloadRetirementEvidence(locator, latest);
    }
    return corruptResult(
      "manifest-corrupt",
      new Error("Attempt payload manifest points at record content")
    );
  }

  private async readPayloadRetirementEvidence(
    locator: AttemptRunRecordLocator,
    latest: Extract<LatestManifestResult, { state: "present" }>
  ): Promise<AttemptPayloadRetirementReadEvidence> {
    try {
      const retirementReceipt = validateAttemptPayloadRetirementReceipt(
        await readJsonFile(path.join(
          latest.layout.generationsPath,
          latest.manifest.generation,
          "record.json"
        ))
      );
      const tombstonePointer = latest.chain.at(-2);
      const priorPointer = latest.chain.at(-3);
      if (
        latest.manifest.contentKind !== "retired"
        || latest.manifest.contentDigest !== retirementReceipt.digest
        || latest.manifest.revision !== retirementReceipt.revision
        || retirementReceipt.workflowRunId !== locator.workflowRunId
        || retirementReceipt.attemptId !== locator.attemptId
        || !tombstonePointer
        || tombstonePointer.contentKind !== "expired"
        || tombstonePointer.contentDigest
          !== latest.manifest.previousContentDigest
        || tombstonePointer.contentDigest
          !== retirementReceipt.tombstoneDigest
        || tombstonePointer.revision
          !== retirementReceipt.tombstoneRevision
        || !priorPointer
        || priorPointer.contentKind !== "payload"
        || priorPointer.generation
          !== retirementReceipt.priorGeneration
        || priorPointer.digest
          !== retirementReceipt.priorGenerationManifestDigest
        || priorPointer.contentDigest
          !== retirementReceipt.priorPayloadDigest
      ) {
        throw new Error("payload retirement receipt chain is inconsistent");
      }
      const tombstone = validateRetentionTombstone(
        await readJsonFile(path.join(
          latest.layout.generationsPath,
          tombstonePointer.generation,
          "record.json"
        ))
      );
      if (
        tombstone.scope !== "attempt-payload"
        || tombstone.reasonCode !== "policy-expired"
        || tombstone.workflowRunId !== retirementReceipt.workflowRunId
        || tombstone.attemptId !== retirementReceipt.attemptId
        || tombstone.harnessRunId !== retirementReceipt.harnessRunId
        || tombstone.subjectDigest !== retirementReceipt.subjectDigest
        || tombstone.digest !== retirementReceipt.tombstoneDigest
        || tombstone.revision !== retirementReceipt.tombstoneRevision
        || tombstone.prior.digest
          !== retirementReceipt.priorPayloadDigest
        || tombstone.retentionTransactionId
          !== retirementReceipt.retentionTransactionId
      ) {
        throw new Error(
          "payload retirement receipt does not bind its tombstone"
        );
      }
      if (
        await lstatOrNull(path.join(
          latest.layout.generationsPath,
          priorPointer.generation
        ))
      ) {
        throw new Error(
          "retired payload generation is still present in the Run Store"
        );
      }
      return {
        state: "expired",
        tombstone,
        retirementReceipt
      };
    } catch (error) {
      return corruptResult("retirement-receipt-corrupt", error);
    }
  }

  async inspectAttemptPayloadUserDeletion(
    input: AttemptPayloadUserDeletionProbe
  ): Promise<AttemptPayloadUserDeletionObservation> {
    const locator = validateAttemptPayloadUserDeletionProbe(input);
    const latest = await this.readLatestManifest(
      "attempt-payload",
      attemptRecordSubjectId(locator)
    );
    if (latest.state === "missing") {
      throw new RunRecordStoreConflictError(
        `Attempt payload ${locator.workflowRunId}/${locator.attemptId} is missing`
      );
    }
    if (latest.state === "corrupt") {
      throw new RunRecordStoreCorruptError(latest.code, latest.error);
    }
    if (latest.orphan) {
      throw new RunRecordStoreConflictError(
        `Attempt payload ${locator.workflowRunId}/${locator.attemptId} requires generation recovery`
      );
    }
    const matches: Array<{
      index: number;
      pointer: RunRecordGenerationManifest;
      tombstone: RunRetentionTombstoneV1;
    }> = [];
    for (const [index, pointer] of latest.chain.entries()) {
      if (pointer.contentKind !== "expired") continue;
      const tombstone = validateRetentionTombstone(
        await readJsonFile(path.join(
          latest.layout.generationsPath,
          pointer.generation,
          "record.json"
        ))
      );
      if (
        tombstone.scope === "attempt-payload"
        && tombstone.reasonCode === "user-deleted"
        && tombstone.workflowRunId === locator.workflowRunId
        && tombstone.attemptId === locator.attemptId
        && tombstone.retentionTransactionId === locator.forwardEffectId
      ) {
        matches.push({ index, pointer, tombstone });
      }
    }
    if (matches.length > 1) {
      throw new RunRecordStoreCorruptError(
        "tombstone-corrupt",
        "Attempt payload has duplicate user-deletion tombstones"
      );
    }
    const match = matches[0];
    if (!match) {
      const current = await this.readAttemptPayload(locator);
      if (current.state === "corrupt") {
        throw new RunRecordStoreCorruptError(current.code, current.error);
      }
      if (current.state !== "present") {
        throw new RunRecordStoreConflictError(
          `Attempt payload cannot begin source deletion from ${current.state}`
        );
      }
      return {
        status: "before",
        manifest: current.manifest
      };
    }
    if (
      match.index === latest.chain.length - 1
      && latest.manifest.digest === match.pointer.digest
    ) {
      return {
        status: "source-deleted",
        tombstone: match.tombstone
      };
    }
    const restoredPointer = latest.chain[match.index + 1];
    if (
      match.index + 1 !== latest.chain.length - 1
      || !restoredPointer
      || restoredPointer.contentKind !== "payload"
      || latest.manifest.digest !== restoredPointer.digest
    ) {
      throw new RunRecordStoreConflictError(
        "Attempt payload changed after its user-deletion tombstone"
      );
    }
    const restored = await this.readAttemptPayload(locator);
    if (restored.state === "corrupt") {
      throw new RunRecordStoreCorruptError(restored.code, restored.error);
    }
    const priorPointer = latest.chain[match.index - 1];
    if (
      !priorPointer
      || priorPointer.contentKind !== "payload"
      || priorPointer.contentDigest !== match.tombstone.prior.digest
    ) {
      throw new RunRecordStoreCorruptError(
        "tombstone-corrupt",
        "Attempt payload restoration lacks its prior payload pointer"
      );
    }
    const prior = await this.readPresentPayload(
      locator,
      path.join(
        latest.layout.generationsPath,
        priorPointer.generation
      ),
      priorPointer
    );
    if (
      restored.state !== "present"
      || prior.state !== "present"
      || !sameRestoredAttemptPayload(
        restored.manifest,
        prior.manifest,
        match.tombstone
      )
    ) {
      throw new RunRecordStoreCorruptError(
        "payload-manifest-corrupt",
        "Attempt payload restoration does not match its tombstone"
      );
    }
    return {
      status: "source-restored",
      tombstone: match.tombstone,
      restoredManifest: restored.manifest,
      restoredAt: restoredPointer.committedAt
    };
  }

  async recoverAttemptPayloadUserDeletion(
    input: AttemptPayloadUserDeletionProbe
  ): Promise<void> {
    const probe = validateAttemptPayloadUserDeletionProbe(input);
    const latest = await this.readLatestManifest(
      "attempt-payload",
      attemptRecordSubjectId(probe)
    );
    if (latest.state === "missing") {
      throw new RunRecordStoreConflictError(
        "Attempt payload source deletion recovery subject is missing"
      );
    }
    if (latest.state === "corrupt") {
      throw new RunRecordStoreCorruptError(latest.code, latest.error);
    }
    const orphan = latest.orphan;
    if (!orphan) return;
    const orphanGenerationPath = path.join(
      latest.layout.generationsPath,
      orphan.generation
    );
    if (orphan.contentKind === "expired") {
      const tombstone = validateRetentionTombstone(
        await readJsonFile(path.join(
          orphanGenerationPath,
          "record.json"
        ))
      );
      if (
        tombstone.scope !== "attempt-payload"
        || tombstone.reasonCode !== "user-deleted"
        || tombstone.workflowRunId !== probe.workflowRunId
        || tombstone.attemptId !== probe.attemptId
        || tombstone.retentionTransactionId !== probe.forwardEffectId
      ) {
        throw new RunRecordStoreConflictError(
          "Attempt payload source deletion recovery orphan conflicts"
        );
      }
      await this.publishAttemptPayloadTombstone(tombstone, {
        expectedRevision: latest.manifest.revision,
        expectedDigest: latest.manifest.contentDigest
      });
      return;
    }
    if (
      orphan.contentKind !== "payload"
      || latest.manifest.contentKind !== "expired"
    ) {
      throw new RunRecordStoreConflictError(
        "Attempt payload source deletion has an unsupported recovery orphan"
      );
    }
    const tombstone = validateRetentionTombstone(
      await readJsonFile(path.join(
        latest.layout.generationsPath,
        latest.manifest.generation,
        "record.json"
      ))
    );
    if (
      tombstone.scope !== "attempt-payload"
      || tombstone.reasonCode !== "user-deleted"
      || tombstone.workflowRunId !== probe.workflowRunId
      || tombstone.attemptId !== probe.attemptId
      || tombstone.retentionTransactionId !== probe.forwardEffectId
    ) {
      throw new RunRecordStoreConflictError(
        "Attempt payload restoration recovery tombstone conflicts"
      );
    }
    const priorPointer = latest.chain.at(-2);
    if (
      !priorPointer
      || priorPointer.contentKind !== "payload"
      || priorPointer.contentDigest !== tombstone.prior.digest
    ) {
      throw new RunRecordStoreCorruptError(
        "tombstone-corrupt",
        "Attempt payload restoration recovery prior pointer is invalid"
      );
    }
    const prior = await this.readPresentPayload(
      probe,
      path.join(
        latest.layout.generationsPath,
        priorPointer.generation
      ),
      priorPointer
    );
    if (prior.state === "corrupt") {
      throw new RunRecordStoreCorruptError(prior.code, prior.error);
    }
    if (prior.state !== "present") {
      throw new RunRecordStoreCorruptError(
        "generation-missing",
        "Attempt payload restoration recovery source is missing"
      );
    }
    const restoredManifest = restoredAttemptPayloadManifest(
      prior.manifest,
      orphan.revision
    );
    if (restoredManifest.digest !== orphan.contentDigest) {
      throw new RunRecordStoreConflictError(
        "Attempt payload restoration recovery orphan digest conflicts"
      );
    }
    await this.publishGeneration({
      recordKind: "attempt-payload",
      subjectId: attemptRecordSubjectId(probe),
      revision: restoredManifest.revision,
      contentKind: "payload",
      contentDigest: restoredManifest.digest,
      cas: {
        expectedRevision: latest.manifest.revision,
        expectedDigest: latest.manifest.contentDigest
      },
      files: [
        {
          relativePath: "manifest.json",
          content: jsonLine(restoredManifest)
        },
        {
          relativePath: "events.jsonl",
          content: serializeAttemptPayloadEvents(prior.events, {
            workflowRunId: restoredManifest.workflowRunId,
            attemptId: restoredManifest.attemptId,
            harnessRunId: restoredManifest.harnessRunId
          })
        }
      ],
      allowedPreviousContentKinds: ["expired"],
      committedAt: orphan.committedAt
    });
  }

  async restoreAttemptPayloadUserDeletion(input: {
    workflowRunId: string;
    attemptId: string;
    forwardEffectId: string;
    occurredAt: number;
    faultInjector?: RunRecordStoreFaultInjector;
  }): Promise<AttemptPayloadUserDeletionObservation> {
    const probe = validateAttemptPayloadUserDeletionProbe(input);
    await this.recoverAttemptPayloadUserDeletion(probe);
    const occurredAt = requireRunRecordTimestamp(
      input.occurredAt,
      "occurredAt"
    );
    const observed = await this.inspectAttemptPayloadUserDeletion(probe);
    if (observed.status === "before") {
      throw new RunRecordStoreConflictError(
        "Attempt payload source deletion tombstone is missing"
      );
    }
    if (observed.status === "source-restored") return observed;
    const latest = await this.readLatestManifest(
      "attempt-payload",
      attemptRecordSubjectId(probe)
    );
    if (latest.state !== "present" || latest.orphan) {
      throw new RunRecordStoreConflictError(
        "Attempt payload source deletion is not a recoverable active tombstone"
      );
    }
    const priorPointer = latest.chain.at(-2);
    if (
      !priorPointer
      || priorPointer.contentKind !== "payload"
      || priorPointer.contentDigest !== observed.tombstone.prior.digest
    ) {
      throw new RunRecordStoreCorruptError(
        "tombstone-corrupt",
        "Attempt payload source deletion lacks its prior payload pointer"
      );
    }
    const prior = await this.readPresentPayload(
      probe,
      path.join(
        latest.layout.generationsPath,
        priorPointer.generation
      ),
      priorPointer
    );
    if (prior.state === "corrupt") {
      throw new RunRecordStoreCorruptError(prior.code, prior.error);
    }
    if (prior.state !== "present") {
      throw new RunRecordStoreCorruptError(
        "generation-missing",
        "Attempt payload source bytes have not been restored"
      );
    }
    const restoredManifest = restoredAttemptPayloadManifest(
      prior.manifest,
      latest.manifest.revision + 1
    );
    await this.publishGeneration({
      recordKind: "attempt-payload",
      subjectId: attemptRecordSubjectId(probe),
      revision: restoredManifest.revision,
      contentKind: "payload",
      contentDigest: restoredManifest.digest,
      cas: {
        expectedRevision: latest.manifest.revision,
        expectedDigest: latest.manifest.contentDigest
      },
      files: [
        {
          relativePath: "manifest.json",
          content: jsonLine(restoredManifest)
        },
        {
          relativePath: "events.jsonl",
          content: serializeAttemptPayloadEvents(prior.events, {
            workflowRunId: restoredManifest.workflowRunId,
            attemptId: restoredManifest.attemptId,
            harnessRunId: restoredManifest.harnessRunId
          })
        }
      ],
      faultInjector: input.faultInjector,
      allowedPreviousContentKinds: ["expired"],
      committedAt: occurredAt
    });
    const readback = await this.inspectAttemptPayloadUserDeletion(probe);
    if (readback.status !== "source-restored") {
      throw new RunRecordStoreCorruptError(
        "record-corrupt",
        "Attempt payload source restoration readback failed"
      );
    }
    return readback;
  }

  /**
   * Strict, read-only owner inventory used before a destructive Conversation
   * mutation. It scans every Run Record subject so a corrupt or unowned record
   * cannot be mistaken for an unrelated record that is safe to ignore.
   */
  async inventoryConversationRunRecords(
    conversationIdInput: string
  ): Promise<ConversationRunRecordInventory> {
    const conversationId = requireInventoryIdentity(
      conversationIdInput,
      "conversationId"
    );
    const store = await this.inventoryRunRecords();
    const workflowRuns = store.workflowRuns.filter((workflow) =>
      workflow.summary.conversationRef?.conversationId === conversationId
    );
    return {
      conversationId,
      workflowRuns,
      storeRawOwners: store.storeRawOwners,
      blockers: store.blockers,
      snapshotDigest: canonicalRunRecordDigest({
        conversationId,
        storeSnapshotDigest: store.snapshotDigest,
        workflowRuns
      })
    };
  }

  /**
   * Strict, stable inventory of every active Run Record subject. This is the
   * authority for global owner and retention planning.
   */
  async inventoryRunRecords(): Promise<RunRecordStoreInventory> {
    const before = await this.scanInventorySnapshot();
    const workflows = new Map<string, WorkflowRunSummaryV1>();
    const workflowTombstones = new Map<
      string,
      RunRetentionTombstoneV1
    >();
    const attempts = new Map<string, AttemptRunSummaryV1>();
    const attemptTombstones = new Map<
      string,
      RunRetentionTombstoneV1
    >();
    const payloads = new Map<string, ConversationAttemptPayloadInventory>();

    for (const workflowRunId of before.workflowRunIds) {
      const read = await this.readWorkflowRunSummary(workflowRunId);
      if (read.state === "corrupt") {
        throw new RunRecordStoreCorruptError(read.code, read.error);
      }
      if (read.state === "expired") {
        workflows.set(workflowRunId, read.priorRecord);
        workflowTombstones.set(workflowRunId, read.tombstone);
        continue;
      }
      if (read.state !== "present") {
        throw new RunRecordStoreCorruptError(
          "record-corrupt",
          `Workflow Run ${workflowRunId} disappeared during inventory`
        );
      }
      workflows.set(workflowRunId, read.record);
    }
    for (const locator of before.attemptLocators) {
      const read = await this.readAttemptRunSummary(locator);
      if (read.state === "corrupt") {
        throw new RunRecordStoreCorruptError(read.code, read.error);
      }
      if (read.state === "expired") {
        const key = attemptInventoryKey(locator);
        attempts.set(key, read.priorRecord);
        attemptTombstones.set(key, read.tombstone);
        continue;
      }
      if (read.state !== "present") {
        throw new RunRecordStoreCorruptError(
          "record-corrupt",
          `Attempt Run ${locator.workflowRunId}/${locator.attemptId} disappeared during inventory`
        );
      }
      attempts.set(attemptInventoryKey(locator), read.record);
    }
    for (const locator of before.payloadLocators) {
      const read = await this.readAttemptPayload(locator);
      if (read.state === "corrupt") {
        throw new RunRecordStoreCorruptError(read.code, read.error);
      }
      payloads.set(
        attemptInventoryKey(locator),
        summarizeAttemptPayloadInventory(
          read,
          activeAttemptPayloadRelativePath(before, locator)
        )
      );
    }

    assertRunInventoryOwnershipComplete(
      workflows,
      attempts,
      payloads,
      before
    );
    assertExpiredRunInventoryIsComplete(
      workflows,
      workflowTombstones,
      attempts,
      attemptTombstones,
      payloads
    );
    const blockers: ConversationRunRecordInventoryBlocker[] = [];
    const allWorkflowRuns = [...workflows.values()]
      .sort((left, right) =>
        left.workflowRunId.localeCompare(right.workflowRunId)
      )
      .map((summary): ConversationWorkflowRunInventory => {
        const expectedAttemptIds = new Set(
          summary.attemptRefs.map((reference) => reference.attemptId)
        );
        const workflowAttempts = [...attempts.values()]
          .filter((attempt) =>
            attempt.workflowRunId === summary.workflowRunId
          )
          .sort(compareAttemptSummaries);
        const workflowPayloads = [...before.payloadLocators]
          .filter((locator) =>
            locator.workflowRunId === summary.workflowRunId
          );
        for (const attempt of workflowAttempts) {
          if (!expectedAttemptIds.has(attempt.attemptId)) {
            blockers.push({
              code: "unexpected-attempt-summary",
              workflowRunId: summary.workflowRunId,
              attemptId: attempt.attemptId,
              recordDigest: attempt.digest
            });
          }
        }
        for (const locator of workflowPayloads) {
          if (!expectedAttemptIds.has(locator.attemptId)) {
            blockers.push({
              code: "unexpected-attempt-payload",
              workflowRunId: summary.workflowRunId,
              attemptId: locator.attemptId,
              recordDigest: payloadInventoryDigest(
                payloads.get(attemptInventoryKey(locator))
              )
            });
          }
        }
        const inventoryAttempts = summary.attemptRefs.map((reference) => {
          const locator = {
            workflowRunId: summary.workflowRunId,
            attemptId: reference.attemptId
          };
          const key = attemptInventoryKey(locator);
          const attempt = attempts.get(key) ?? null;
          const payload = payloads.get(key) ?? { state: "missing" as const };
          if (!attempt) {
            blockers.push({
              code: "missing-attempt-summary",
              workflowRunId: summary.workflowRunId,
              attemptId: reference.attemptId
            });
          } else {
            if (attempt.ordinal !== reference.ordinal) {
              blockers.push({
                code: "attempt-ordinal-mismatch",
                workflowRunId: summary.workflowRunId,
                attemptId: reference.attemptId,
                recordDigest: attempt.digest
              });
            }
            const payloadIdentity = payloadHarnessRunId(payload);
            if (
              payloadIdentity !== null
              && payloadIdentity !== attempt.harnessRunId
            ) {
              blockers.push({
                code: "attempt-payload-harness-mismatch",
                workflowRunId: summary.workflowRunId,
                attemptId: reference.attemptId,
                recordDigest: payloadInventoryDigest(payload)
              });
            }
            const payloadStateMatches = attempt.payload.expected
              ? payload.state === "present" || payload.state === "expired"
              : payload.state === "not-captured";
            if (!payloadStateMatches) {
              blockers.push({
                code: payload.state === "missing"
                  ? "missing-attempt-payload"
                  : "payload-state-mismatch",
                workflowRunId: summary.workflowRunId,
                attemptId: reference.attemptId,
                recordDigest: payloadInventoryDigest(payload)
              });
            }
          }
          return {
            attemptId: reference.attemptId,
            ordinal: reference.ordinal,
            summary: attempt,
            ...(attemptTombstones.has(key)
              ? { summaryTombstone: attemptTombstones.get(key)! }
              : {}),
            payload
          };
        });
        return {
          summary,
          ...(workflowTombstones.has(summary.workflowRunId)
            ? {
                summaryTombstone:
                  workflowTombstones.get(summary.workflowRunId)!
              }
            : {}),
          attempts: inventoryAttempts
        };
      });
    blockers.sort(compareInventoryBlockers);
    const storeRawOwners = [...payloads.entries()]
      .flatMap(([key, payload]) => {
        if (payload.state !== "present" || !payload.rawRefs.length) return [];
        const locator = parseAttemptInventoryKey(key);
        const workflow = workflows.get(locator.workflowRunId);
        return payload.rawRefs.map((rawRef) => ({
          rawRef,
          workflowRunId: locator.workflowRunId,
          attemptId: locator.attemptId,
          ...(workflow?.conversationRef?.conversationId
            ? {
                conversationId:
                  workflow.conversationRef.conversationId
              }
            : {})
        }));
      })
      .sort((left, right) => (
        left.rawRef.localeCompare(right.rawRef)
        || left.workflowRunId.localeCompare(right.workflowRunId)
        || left.attemptId.localeCompare(right.attemptId)
      ));
    const after = await this.scanInventorySnapshot();
    if (after.digest !== before.digest) {
      throw new RunRecordStoreConflictError(
        "Run Record Store changed during Conversation inventory"
      );
    }
    const snapshotDigest = canonicalRunRecordDigest({
      storeDigest: before.digest,
      workflowRuns: allWorkflowRuns,
      storeRawOwners,
      blockers
    });
    return {
      workflowRuns: allWorkflowRuns,
      storeRawOwners,
      blockers,
      snapshotDigest
    };
  }

  private async scanInventorySnapshot():
  Promise<RunRecordStoreInventorySnapshot> {
    const rootStat = await lstatOrNull(this.rootPath);
    if (!rootStat) {
      return runRecordStoreInventorySnapshot([], [], [], []);
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new RunRecordStoreCorruptError(
        "unsafe-path",
        "Run Record Store root is not a plain directory"
      );
    }
    const expectedCollections = [
      ".staging",
      "attempt-payloads",
      "attempt-summaries",
      "workflow-summaries"
    ];
    const rootEntries = await readdir(this.rootPath, {
      withFileTypes: true
    });
    const actualNames = rootEntries
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    if (
      actualNames.length !== expectedCollections.length
      || actualNames.some(
        (name, index) => name !== expectedCollections[index]
      )
      || rootEntries.some(
        (entry) => !entry.isDirectory() || entry.isSymbolicLink()
      )
    ) {
      throw new RunRecordStoreCorruptError(
        "unsafe-path",
        "Run Record Store root layout contains an unknown or unsafe entry"
      );
    }
    const stagingEntries = await readdir(path.join(
      this.rootPath,
      ".staging"
    ));
    if (stagingEntries.length) {
      throw new RunRecordStoreCorruptError(
        "manifest-corrupt",
        "Run Record Store staging directory requires recovery"
      );
    }

    const workflowSubjects = await this.scanCollectionSubjects(
      "workflow-summary"
    );
    const attemptSubjects = await this.scanCollectionSubjects(
      "attempt-summary"
    );
    const payloadSubjects = await this.scanCollectionSubjects(
      "attempt-payload"
    );
    const workflowRunIds = workflowSubjects.map((subject) => {
      if (typeof subject.identity !== "string") {
        throw new RunRecordStoreCorruptError(
          "record-corrupt",
          "Workflow Run inventory identity is invalid"
        );
      }
      return subject.identity;
    });
    const attemptLocators = attemptSubjects.map((subject) => {
      if (typeof subject.identity === "string") {
        throw new RunRecordStoreCorruptError(
          "record-corrupt",
          "Attempt Run inventory identity is invalid"
        );
      }
      return subject.identity;
    });
    const payloadLocators = payloadSubjects.map((subject) => {
      if (typeof subject.identity === "string") {
        throw new RunRecordStoreCorruptError(
          "record-corrupt",
          "Attempt payload inventory identity is invalid"
        );
      }
      return subject.identity;
    });
    return runRecordStoreInventorySnapshot(
      workflowRunIds,
      attemptLocators,
      payloadLocators,
      [
        ...workflowSubjects,
        ...attemptSubjects,
        ...payloadSubjects
      ].map((subject) => ({
        recordKind: subject.recordKind,
        subjectToken: subject.subjectToken,
        manifestDigest: subject.manifestDigest,
        generation: subject.generation,
        contentKind: subject.contentKind
      }))
    );
  }

  private async scanCollectionSubjects(
    recordKind: RunRecordStoreRecordKind
  ): Promise<Array<{
    recordKind: RunRecordStoreRecordKind;
    subjectToken: string;
    manifestDigest: string;
    generation: string;
    contentKind: RunRecordStoreContentKind;
    identity: string | AttemptRunRecordLocator;
  }>> {
    const collectionPath = path.join(
      this.rootPath,
      collectionDirectory(recordKind)
    );
    const entries = await readdir(collectionPath, {
      withFileTypes: true
    });
    const subjects: Array<{
      recordKind: RunRecordStoreRecordKind;
      subjectToken: string;
      manifestDigest: string;
      generation: string;
      contentKind: RunRecordStoreContentKind;
      identity: string | AttemptRunRecordLocator;
    }> = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || !/^[a-z0-9._-]+-[a-f0-9]{64}$/.test(entry.name)
      ) {
        throw new RunRecordStoreCorruptError(
          "unsafe-path",
          `Unexpected Run record subject entry ${entry.name}`
        );
      }
      subjects.push(await this.readInventorySubjectIdentity(
        recordKind,
        entry.name
      ));
    }
    return subjects;
  }

  private async readInventorySubjectIdentity(
    recordKind: RunRecordStoreRecordKind,
    subjectToken: string
  ): Promise<{
    recordKind: RunRecordStoreRecordKind;
    subjectToken: string;
    manifestDigest: string;
    generation: string;
    contentKind: RunRecordStoreContentKind;
    identity: string | AttemptRunRecordLocator;
  }> {
    const subjectRootPath = path.join(
      this.rootPath,
      collectionDirectory(recordKind),
      subjectToken
    );
    const head = validateRunRecordHead(
      await readJsonFile(path.join(subjectRootPath, "head.json"))
    );
    if (
      head.recordKind !== recordKind
      || head.subjectToken !== subjectToken
    ) {
      throw new RunRecordStoreCorruptError(
        "manifest-corrupt",
        "Run record inventory head identity does not match its path"
      );
    }
    const manifest = validateGenerationManifest(
      await readJsonFile(path.join(
        subjectRootPath,
        "manifests",
        manifestFileName(head.revision)
      ))
    );
    if (
      manifest.recordKind !== recordKind
      || manifest.subjectToken !== subjectToken
      || manifest.revision !== head.revision
      || manifest.digest !== head.manifestDigest
    ) {
      throw new RunRecordStoreCorruptError(
        "manifest-corrupt",
        "Run record inventory manifest does not match its head"
      );
    }
    const generationPath = path.join(
      subjectRootPath,
      "generations",
      manifest.generation
    );
    let identity: string | AttemptRunRecordLocator;
    if (recordKind === "workflow-summary") {
      if (manifest.contentKind === "expired") {
        const tombstone = validateRetentionTombstone(
          await readJsonFile(path.join(generationPath, "record.json"))
        );
        if (
          tombstone.scope !== "workflow-summary"
          || tombstone.revision !== manifest.revision
          || tombstone.digest !== manifest.contentDigest
        ) {
          throw new RunRecordStoreCorruptError(
            "tombstone-corrupt",
            "Workflow summary inventory tombstone is invalid"
          );
        }
        identity = tombstone.workflowRunId;
      } else if (manifest.contentKind !== "record") {
        throw new RunRecordStoreCorruptError(
          "manifest-corrupt",
          "Workflow Run inventory manifest points at non-record content"
        );
      } else {
        const summary = validateWorkflowRunSummary(
          await readJsonFile(path.join(generationPath, "record.json"))
        );
        assertInventoryGenerationIdentity(summary, manifest);
        identity = summary.workflowRunId;
      }
    } else if (recordKind === "attempt-summary") {
      if (manifest.contentKind === "expired") {
        const tombstone = validateRetentionTombstone(
          await readJsonFile(path.join(generationPath, "record.json"))
        );
        if (
          tombstone.scope !== "attempt-summary"
          || !tombstone.attemptId
          || tombstone.revision !== manifest.revision
          || tombstone.digest !== manifest.contentDigest
        ) {
          throw new RunRecordStoreCorruptError(
            "tombstone-corrupt",
            "Attempt summary inventory tombstone is invalid"
          );
        }
        identity = {
          workflowRunId: tombstone.workflowRunId,
          attemptId: tombstone.attemptId
        };
      } else if (manifest.contentKind !== "record") {
        throw new RunRecordStoreCorruptError(
          "manifest-corrupt",
          "Attempt Run inventory manifest points at non-record content"
        );
      } else {
        const summary = validateAttemptRunSummary(
          await readJsonFile(path.join(generationPath, "record.json"))
        );
        assertInventoryGenerationIdentity(summary, manifest);
        identity = {
          workflowRunId: summary.workflowRunId,
          attemptId: summary.attemptId
        };
      }
    } else if (manifest.contentKind === "payload") {
      const payload = validateAttemptPayloadManifest(
        await readJsonFile(path.join(generationPath, "manifest.json"))
      );
      assertInventoryGenerationIdentity(payload, manifest);
      identity = {
        workflowRunId: payload.workflowRunId,
        attemptId: payload.attemptId
      };
    } else if (manifest.contentKind === "not-captured") {
      const payload = validateNotCapturedRecord(
        await readJsonFile(path.join(generationPath, "record.json"))
      );
      assertInventoryGenerationIdentity(payload, manifest);
      identity = {
        workflowRunId: payload.workflowRunId,
        attemptId: payload.attemptId
      };
    } else if (manifest.contentKind === "expired") {
      const payload = validateRetentionTombstone(
        await readJsonFile(path.join(generationPath, "record.json"))
      );
      if (payload.scope !== "attempt-payload" || !payload.attemptId) {
        throw new RunRecordStoreCorruptError(
          "tombstone-corrupt",
          "Run record inventory payload tombstone identity is invalid"
        );
      }
      assertInventoryGenerationIdentity(payload, manifest);
      identity = {
        workflowRunId: payload.workflowRunId,
        attemptId: payload.attemptId
      };
    } else if (manifest.contentKind === "retired") {
      const receipt = validateAttemptPayloadRetirementReceipt(
        await readJsonFile(path.join(generationPath, "record.json"))
      );
      assertInventoryGenerationIdentity(receipt, manifest);
      identity = {
        workflowRunId: receipt.workflowRunId,
        attemptId: receipt.attemptId
      };
    } else {
      throw new RunRecordStoreCorruptError(
        "manifest-corrupt",
        "Run record inventory content kind is invalid"
      );
    }
    const expectedSubjectToken = typeof identity === "string"
      ? safeRunRecordToken(identity)
      : attemptRunRecordSubjectToken(identity);
    if (expectedSubjectToken !== subjectToken) {
      throw new RunRecordStoreCorruptError(
        "record-corrupt",
        "Run record inventory subject identity does not match its path"
      );
    }
    return {
      recordKind,
      subjectToken,
      manifestDigest: manifest.digest,
      generation: manifest.generation,
      contentKind: manifest.contentKind,
      identity
    };
  }

  private async readSummary<T>(
    recordKind: "workflow-summary" | "attempt-summary",
    tombstoneScope: "workflow-summary" | "attempt-summary",
    subjectId: string,
    validate: (value: unknown) => T,
    identityMatches: (record: T) => boolean
  ): Promise<RunRecordStoreReadResult<T>> {
    const latest = await this.readLatestManifest(recordKind, subjectId);
    if (latest.state === "missing") return { state: "missing" };
    if (latest.state === "corrupt") {
      return {
        state: "corrupt",
        code: latest.code,
        error: latest.error
      };
    }
    if (latest.manifest.contentKind === "expired") {
      try {
        const tombstone = validateRetentionTombstone(
          await readJsonFile(path.join(
            latest.layout.generationsPath,
            latest.manifest.generation,
            "record.json"
          ))
        );
        if (
          tombstone.scope !== tombstoneScope
          || tombstone.revision !== latest.manifest.revision
          || tombstone.digest !== latest.manifest.contentDigest
          || tombstone.revision <= 0
        ) {
          throw new Error("summary tombstone identity mismatch");
        }
        const priorPointer = validateGenerationManifest(
          await readJsonFile(path.join(
            latest.layout.manifestsPath,
            manifestFileName(tombstone.revision - 1)
          ))
        );
        if (
          priorPointer.recordKind !== recordKind
          || priorPointer.subjectToken !== latest.manifest.subjectToken
          || priorPointer.contentKind !== "record"
          || priorPointer.contentDigest !== tombstone.prior.digest
          || latest.manifest.previousContentDigest
            !== priorPointer.contentDigest
        ) {
          throw new Error(
            "summary tombstone lacks its active prior summary"
          );
        }
        const priorRecord = validate(await readJsonFile(path.join(
          latest.layout.generationsPath,
          priorPointer.generation,
          "record.json"
        )));
        const prior = priorRecord as {
          workflowRunId?: unknown;
          attemptId?: unknown;
          revision?: unknown;
          terminalAt?: unknown;
          digest?: unknown;
        };
        if (
          !identityMatches(priorRecord)
          || prior.revision !== priorPointer.revision
          || prior.digest !== priorPointer.contentDigest
          || prior.digest !== tombstone.prior.digest
          || prior.terminalAt !== tombstone.prior.terminalAt
          || prior.workflowRunId !== tombstone.workflowRunId
          || (
            tombstoneScope === "attempt-summary"
            && prior.attemptId !== tombstone.attemptId
          )
        ) {
          throw new Error("summary tombstone prior record mismatch");
        }
        return { state: "expired", tombstone, priorRecord };
      } catch (error) {
        return corruptResult("tombstone-corrupt", error);
      }
    }
    if (latest.manifest.contentKind !== "record") {
      return corruptResult(
        "manifest-corrupt",
        new Error("Summary manifest points at non-record content")
      );
    }
    try {
      const record = validate(await readJsonFile(path.join(
        latest.layout.generationsPath,
        latest.manifest.generation,
        "record.json"
      )));
      const revision = (record as { revision?: unknown }).revision;
      const digest = (record as { digest?: unknown }).digest;
      if (
        !identityMatches(record)
        || revision !== latest.manifest.revision
        || digest !== latest.manifest.contentDigest
      ) {
        throw new Error("summary generation identity mismatch");
      }
      return { state: "present", record };
    } catch (error) {
      return corruptResult("record-corrupt", error);
    }
  }

  private async readPresentPayload(
    locator: AttemptRunRecordLocator,
    generationPath: string,
    pointer: RunRecordGenerationManifest
  ): Promise<AttemptPayloadReadResult> {
    let manifest: AttemptPayloadManifestV1;
    try {
      manifest = validateAttemptPayloadManifest(
        await readJsonFile(path.join(generationPath, "manifest.json"))
      );
      if (
        manifest.workflowRunId !== locator.workflowRunId
        || manifest.attemptId !== locator.attemptId
        || manifest.revision !== pointer.revision
        || manifest.digest !== pointer.contentDigest
      ) {
        throw new Error("payload generation identity mismatch");
      }
    } catch (error) {
      return corruptResult("payload-manifest-corrupt", error);
    }

    let raw: string;
    try {
      raw = await readUtf8FileSafely(
        path.join(generationPath, "events.jsonl"),
        RUN_RECORD_MAX_PAYLOAD_BYTES
      );
    } catch (error) {
      return corruptResult("generation-missing", error);
    }
    let parsedEvents: unknown[];
    try {
      parsedEvents = raw
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);
    } catch (error) {
      return corruptResult("payload-jsonl-corrupt", error);
    }
    let canonical: string;
    let events: AttemptHarnessEventV1[];
    try {
      events = parsedEvents.map((event) => validateAttemptHarnessEvent(event));
      canonical = serializeAttemptPayloadEvents(events, {
        workflowRunId: manifest.workflowRunId,
        attemptId: manifest.attemptId,
        harnessRunId: manifest.harnessRunId
      });
    } catch (error) {
      return corruptResult("payload-event-invalid", error);
    }
    if (
      canonical !== raw
      || Buffer.byteLength(raw) !== manifest.byteCount
      || sha256(raw) !== manifest.payloadSha256
      || events.length !== manifest.eventCount
    ) {
      return corruptResult(
        "payload-digest-mismatch",
        new Error("payload bytes do not match sealed manifest")
      );
    }
    return { state: "present", manifest, events };
  }

  private async publishSummaryTombstone<T extends
    WorkflowRunSummaryV1 | AttemptRunSummaryV1>(input: {
      recordKind: "workflow-summary" | "attempt-summary";
      subjectId: string;
      current: RunRecordStoreReadResult<T>;
      tombstone: RunRetentionTombstoneV1;
      cas: RunRecordStoreCas;
      faultInjector?: RunRecordStoreFaultInjector;
    }): Promise<void> {
    if (input.current.state === "missing") {
      throw new RunRecordStoreConflictError(
        "Cannot publish expired tombstone for a missing summary"
      );
    }
    if (input.current.state === "corrupt") {
      throw new RunRecordStoreCorruptError(
        input.current.code,
        input.current.error
      );
    }
    if (input.current.state === "expired") {
      if (
        input.current.tombstone.digest === input.tombstone.digest
      ) {
        return;
      }
      throw new RunRecordStoreConflictError(
        "Summary already has a different expired tombstone"
      );
    }
    const summary = input.current.record;
    if (
      summary.workflowRunId !== input.tombstone.workflowRunId
      || (
        input.tombstone.scope === "attempt-summary"
        && (
          !("attemptId" in summary)
          || summary.attemptId !== input.tombstone.attemptId
        )
      )
      || summary.digest !== input.tombstone.prior.digest
      || summary.terminalAt === undefined
      || summary.terminalAt !== input.tombstone.prior.terminalAt
      || input.tombstone.revision !== summary.revision + 1
    ) {
      throw new RunRecordStoreConflictError(
        "Summary tombstone does not exactly describe the active summary"
      );
    }
    await this.publishGeneration({
      recordKind: input.recordKind,
      subjectId: input.subjectId,
      revision: input.tombstone.revision,
      contentKind: "expired",
      contentDigest: input.tombstone.digest,
      cas: input.cas,
      files: [{
        relativePath: "record.json",
        content: jsonLine(input.tombstone)
      }],
      faultInjector: input.faultInjector,
      allowedPreviousContentKinds: ["record"],
      committedAt: input.tombstone.committedAt
    });
  }

  private async publishGeneration(
    input: PublishGenerationInput
  ): Promise<void> {
    await this.withMutation(async () => {
      await this.publishGenerationWithAuthority(input);
    });
  }

  private async publishGenerationWithAuthority(
    input: PublishGenerationInput
  ): Promise<void> {
    await this.ensureRoot();
    const current = await this.readLatestManifest(
      input.recordKind,
      input.subjectId
    );
    if (current.state === "corrupt") {
      throw new RunRecordStoreCorruptError(current.code, current.error);
    }
    const previousContentKind = current.state === "present"
      ? current.manifest.contentKind
      : null;
    if (!input.allowedPreviousContentKinds.includes(previousContentKind)) {
      throw new RunRecordStoreConflictError(
        `Run record ${input.recordKind} cannot transition from ${String(previousContentKind)} to ${input.contentKind}`
      );
    }
    assertCas(current, input.cas, input.revision);
    const layout = current.layout;
    await ensurePlainDirectory(layout.subjectRootPath);
    await ensurePlainDirectory(layout.generationsPath);
    await ensurePlainDirectory(layout.manifestsPath);
    const stagingRootPath = path.join(this.rootPath, ".staging");
    await ensurePlainDirectory(stagingRootPath);
    if (current.orphan) {
      await assertRecoveryOrphanMatches(current, input);
      await writeRunRecordHeadAtomically(
        stagingRootPath,
        layout,
        current.orphan
      );
      await input.faultInjector?.("after-manifest-publish");
      return;
    }

    const generation = [
      String(input.revision).padStart(12, "0"),
      input.contentDigest.slice("sha256:".length, "sha256:".length + 16),
      randomUUID()
    ].join("-");
    const stagedGenerationPath = path.join(
      stagingRootPath,
      `.generation-${generation}`
    );
    const finalGenerationPath = path.join(layout.generationsPath, generation);
    const stagedManifestPath = path.join(
      stagingRootPath,
      `.manifest-${safeRunRecordToken(input.subjectId)}-${input.revision}-${randomUUID()}.tmp`
    );
    let generationPublished = false;
    let manifestPublished = false;
    try {
      await mkdir(stagedGenerationPath, { mode: 0o700 });
      for (const file of input.files) {
        if (
          !/^[a-z0-9][a-z0-9._-]*$/i.test(file.relativePath)
          || file.relativePath.includes("..")
        ) {
          throw new RunRecordStoreCorruptError(
            "unsafe-path",
            `Unsafe generation filename: ${file.relativePath}`
          );
        }
        await writeNewFileDurably(
          path.join(stagedGenerationPath, file.relativePath),
          file.content
        );
      }
      await syncDirectory(stagedGenerationPath);
      await syncDirectory(stagingRootPath);
      await rename(stagedGenerationPath, finalGenerationPath);
      generationPublished = true;
      await syncDirectory(layout.generationsPath);
      await input.faultInjector?.("after-generation-sync");

      const pointer = validateGenerationManifest(withDigest({
        schemaVersion: 1,
        recordType: "run-record-generation-manifest",
        recordKind: input.recordKind,
        subjectToken: safeRunRecordToken(input.subjectId),
        revision: input.revision,
        generation,
        contentKind: input.contentKind,
        contentDigest: input.contentDigest,
        previousContentDigest: current.state === "present"
          ? current.manifest.contentDigest
          : null,
        committedAt: input.committedAt === undefined
          ? Date.now()
          : requireRunRecordTimestamp(input.committedAt, "committedAt")
      }));
      await writeNewFileDurably(stagedManifestPath, jsonLine(pointer));
      await syncDirectory(stagingRootPath);
      const manifestPath = path.join(
        layout.manifestsPath,
        manifestFileName(input.revision)
      );
      try {
        await link(stagedManifestPath, manifestPath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new RunRecordStoreConflictError(
            `Run record revision ${input.revision} already has a manifest winner`
          );
        }
        throw error;
      }
      manifestPublished = true;
      await syncDirectory(layout.manifestsPath);
      await input.faultInjector?.("after-manifest-link");
      await writeRunRecordHeadAtomically(
        stagingRootPath,
        layout,
        pointer
      );
      await input.faultInjector?.("after-manifest-publish");
      await unlink(stagedManifestPath);
      await syncDirectory(stagingRootPath);
    } catch (error) {
      if (error instanceof RunRecordStoreSimulatedCrash) throw error;
      await rm(stagedGenerationPath, { recursive: true, force: true })
        .catch(() => undefined);
      await unlink(stagedManifestPath).catch(() => undefined);
      if (!manifestPublished && generationPublished) {
        // An unpublished immutable generation is a safe orphan. It is retained
        // for a future inventory/recovery pass instead of being deleted here.
      }
      throw error;
    }
  }

  private async readLatestManifest(
    recordKind: RunRecordStoreRecordKind,
    subjectId: string
  ): Promise<LatestManifestResult> {
    const layout = this.subjectLayout(recordKind, subjectId);
    try {
      const subjectStat = await lstatOrNull(layout.subjectRootPath);
      if (!subjectStat) return { state: "missing", layout };
      if (!subjectStat.isDirectory() || subjectStat.isSymbolicLink()) {
        return corruptLatest(
          layout,
          "unsafe-path",
          "Run record subject root is not a plain directory"
        );
      }
      const manifestStat = await lstatOrNull(layout.manifestsPath);
      if (!manifestStat) {
        if (await lstatOrNull(layout.headPath)) {
          return corruptLatest(
            layout,
            "manifest-corrupt",
            "Run record head exists without manifests directory"
          );
        }
        return { state: "missing", layout };
      }
      if (!manifestStat.isDirectory() || manifestStat.isSymbolicLink()) {
        return corruptLatest(
          layout,
          "unsafe-path",
          "Run record manifests path is not a plain directory"
        );
      }
      const entries = await readdir(layout.manifestsPath, {
        withFileTypes: true
      });
      if (!entries.length) {
        if (await lstatOrNull(layout.headPath)) {
          return corruptLatest(
            layout,
            "manifest-corrupt",
            "Run record head exists without a manifest chain"
          );
        }
        return { state: "missing", layout };
      }
      const ordered = entries.map((entry) => {
        const match = MANIFEST_FILE_PATTERN.exec(entry.name);
        if (
          !match
          || !entry.isFile()
          || entry.isSymbolicLink()
        ) {
          throw new RunRecordStoreCorruptError(
            "manifest-corrupt",
            `Unexpected manifest entry ${entry.name}`
          );
        }
        return {
          name: entry.name,
          revision: Number(match[1])
        };
      }).sort((left, right) => left.revision - right.revision);

      let previous: RunRecordGenerationManifest | null = null;
      const chain: RunRecordGenerationManifest[] = [];
      for (let index = 0; index < ordered.length; index += 1) {
        const entry = ordered[index];
        if (
          entry.revision !== index
          || entry.name !== manifestFileName(index)
        ) {
          throw new RunRecordStoreCorruptError(
            "manifest-corrupt",
            "Run record manifests are not a contiguous revision chain"
          );
        }
        const manifest = validateGenerationManifest(
          await readJsonFile(path.join(layout.manifestsPath, entry.name))
        );
        if (
          manifest.recordKind !== recordKind
          || manifest.subjectToken !== safeRunRecordToken(subjectId)
          || manifest.revision !== entry.revision
          || manifest.previousContentDigest
            !== (previous?.contentDigest ?? null)
        ) {
          throw new RunRecordStoreCorruptError(
            "manifest-corrupt",
            "Run record manifest chain identity does not match its path"
          );
        }
        previous = manifest;
        chain.push(manifest);
      }
      if (!previous) return { state: "missing", layout };
      const generationsStat = await lstatOrNull(layout.generationsPath);
      if (
        !generationsStat
        || !generationsStat.isDirectory()
        || generationsStat.isSymbolicLink()
      ) {
        return corruptLatest(
          layout,
          generationsStat ? "unsafe-path" : "generation-missing",
          "Run record generations path is missing or unsafe"
        );
      }
      const headStat = await lstatOrNull(layout.headPath);
      if (!headStat) {
        if (chain.length !== 1) {
          throw new RunRecordStoreCorruptError(
            "manifest-corrupt",
            "Run record manifest chain has no commit head"
          );
        }
        await assertSafeGenerationDirectory(
          layout,
          chain[0],
          "Recovery orphan"
        );
        return { state: "missing", layout, orphan: chain[0] };
      }
      const head = validateRunRecordHead(
        await readJsonFile(layout.headPath)
      );
      const committed = chain[head.revision];
      if (
        !committed
        || head.recordKind !== recordKind
        || head.subjectToken !== safeRunRecordToken(subjectId)
        || head.manifestDigest !== committed.digest
        || chain.length > head.revision + 2
      ) {
        throw new RunRecordStoreCorruptError(
          "manifest-corrupt",
          "Run record head does not match the append-only manifest chain"
        );
      }
      const orphan = chain[head.revision + 1];
      await assertSafeGenerationDirectory(layout, committed, "Active");
      if (orphan) {
        await assertSafeGenerationDirectory(layout, orphan, "Recovery orphan");
      }
      return {
        state: "present",
        layout,
        manifest: committed,
        chain: chain.slice(0, head.revision + 1),
        ...(orphan ? { orphan } : {})
      };
    } catch (error) {
      if (error instanceof RunRecordStoreCorruptError) {
        return {
          state: "corrupt",
          layout,
          code: error.code,
          error: error.message
        };
      }
      return {
        state: "corrupt",
        layout,
        code: "manifest-corrupt",
        error: errorMessage(error)
      };
    }
  }

  private subjectLayout(
    recordKind: RunRecordStoreRecordKind,
    subjectId: string
  ): SubjectLayout {
    const subjectRootPath = path.join(
      this.rootPath,
      collectionDirectory(recordKind),
      safeRunRecordToken(subjectId)
    );
    return {
      subjectRootPath,
      generationsPath: path.join(subjectRootPath, "generations"),
      manifestsPath: path.join(subjectRootPath, "manifests"),
      headPath: path.join(subjectRootPath, "head.json")
    };
  }

  private async ensureRoot(): Promise<void> {
    const storageRootPath = path.dirname(this.rootPath);
    const storageStat = await lstat(storageRootPath);
    if (!storageStat.isDirectory() || storageStat.isSymbolicLink()) {
      throw new RunRecordStoreCorruptError(
        "unsafe-path",
        "Run record storage root is not a plain directory"
      );
    }
    await ensurePlainDirectory(this.rootPath);
    for (const child of [
      "workflow-summaries",
      "attempt-summaries",
      "attempt-payloads",
      ".staging"
    ]) {
      await ensurePlainDirectory(path.join(this.rootPath, child));
    }
    await syncDirectory(this.rootPath);
  }
}

function runRecordStoreInventorySnapshot(
  workflowRunIdsInput: readonly string[],
  attemptLocatorsInput: readonly AttemptRunRecordLocator[],
  payloadLocatorsInput: readonly AttemptRunRecordLocator[],
  activeHeadsInput: readonly {
    recordKind: RunRecordStoreRecordKind;
    subjectToken: string;
    manifestDigest: string;
    generation: string;
    contentKind: RunRecordStoreContentKind;
  }[]
): RunRecordStoreInventorySnapshot {
  const workflowRunIds = [...workflowRunIdsInput].sort((left, right) =>
    left.localeCompare(right)
  );
  const attemptLocators = [...attemptLocatorsInput].sort(compareLocators);
  const payloadLocators = [...payloadLocatorsInput].sort(compareLocators);
  const activeHeads = [...activeHeadsInput].sort((left, right) => (
    left.recordKind.localeCompare(right.recordKind)
    || left.subjectToken.localeCompare(right.subjectToken)
  ));
  const draft = {
    workflowRunIds,
    attemptLocators,
    payloadLocators,
    activeHeads
  };
  return {
    ...draft,
    digest: canonicalRunRecordDigest(draft)
  };
}

function activeAttemptPayloadRelativePath(
  snapshot: RunRecordStoreInventorySnapshot,
  locator: AttemptRunRecordLocator
): string {
  const subjectToken = attemptRunRecordSubjectToken(locator);
  const head = snapshot.activeHeads.find((candidate) =>
    candidate.recordKind === "attempt-payload"
    && candidate.subjectToken === subjectToken
  );
  if (!head) {
    throw new RunRecordStoreCorruptError(
      "record-corrupt",
      `Attempt payload ${locator.workflowRunId}/${locator.attemptId} has no active head`
    );
  }
  return [
    "attempt-payloads",
    subjectToken,
    "generations",
    head.generation
  ].join("/");
}

function summarizeAttemptPayloadInventory(
  read: Exclude<AttemptPayloadReadResult, { state: "corrupt" }>,
  sourceRelativePath: string
): ConversationAttemptPayloadInventory {
  if (read.state === "present") {
    return {
      state: "present",
      manifest: read.manifest,
      rawRefs: collectRunPayloadRawRefs(read.events),
      sourceRelativePath
    };
  }
  if (read.state === "expired") {
    return {
      state: "expired",
      tombstone: read.tombstone
    };
  }
  if (read.state === "not-captured") {
    return {
      state: "not-captured",
      reasonCode: read.reasonCode
    };
  }
  return { state: "missing" };
}

function collectRunPayloadRawRefs(
  events: readonly AttemptHarnessEventV1[]
): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32) {
      throw new RunRecordStoreCorruptError(
        "payload-event-invalid",
        "Attempt payload rawRef nesting exceeds the inventory limit"
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (key === "rawRef") {
        if (typeof item !== "string") {
          throw new RunRecordStoreCorruptError(
            "payload-event-invalid",
            "Attempt payload rawRef is not a string"
          );
        }
        refs.add(normalizeRunPayloadRawRef(item));
        continue;
      }
      visit(item, depth + 1);
    }
  };
  for (const event of events) visit(event, 0);
  return [...refs].sort((left, right) => left.localeCompare(right));
}

function normalizeRunPayloadRawRef(value: string): string {
  if (
    value !== value.trim()
    || value.includes("\\")
    || value.includes("..")
    || !/^raw\/[a-zA-Z0-9_.-]{1,160}\.txt$/.test(value)
  ) {
    throw new RunRecordStoreCorruptError(
      "payload-event-invalid",
      "Attempt payload rawRef is unsafe"
    );
  }
  return value;
}

function assertRunInventoryOwnershipComplete(
  workflows: ReadonlyMap<string, WorkflowRunSummaryV1>,
  attempts: ReadonlyMap<string, AttemptRunSummaryV1>,
  payloads: ReadonlyMap<string, ConversationAttemptPayloadInventory>,
  snapshot: RunRecordStoreInventorySnapshot
): void {
  for (const locator of snapshot.attemptLocators) {
    if (!workflows.has(locator.workflowRunId)) {
      throw new RunRecordStoreCorruptError(
        "record-corrupt",
        `Attempt Run ${locator.workflowRunId}/${locator.attemptId} has no Workflow Run owner`
      );
    }
  }
  for (const locator of snapshot.payloadLocators) {
    const key = attemptInventoryKey(locator);
    if (!attempts.has(key) || !payloads.has(key)) {
      throw new RunRecordStoreCorruptError(
        "record-corrupt",
        `Attempt payload ${locator.workflowRunId}/${locator.attemptId} has no Attempt Run owner`
      );
    }
  }
}

function assertExpiredRunInventoryIsComplete(
  workflows: ReadonlyMap<string, WorkflowRunSummaryV1>,
  workflowTombstones: ReadonlyMap<string, RunRetentionTombstoneV1>,
  attempts: ReadonlyMap<string, AttemptRunSummaryV1>,
  attemptTombstones: ReadonlyMap<string, RunRetentionTombstoneV1>,
  payloads: ReadonlyMap<string, ConversationAttemptPayloadInventory>
): void {
  for (const [key, tombstone] of attemptTombstones) {
    const attempt = attempts.get(key);
    const payload = payloads.get(key);
    if (
      !attempt
      || tombstone.scope !== "attempt-summary"
      || (
        attempt.payload.expected
          ? payload?.state !== "expired"
          : payload?.state !== "not-captured"
      )
    ) {
      throw new RunRecordStoreCorruptError(
        "record-corrupt",
        "Expired Attempt summary still has live or incomplete payload state"
      );
    }
  }
  for (const [workflowRunId, tombstone] of workflowTombstones) {
    const workflow = workflows.get(workflowRunId);
    if (
      !workflow
      || tombstone.scope !== "workflow-summary"
    ) {
      throw new RunRecordStoreCorruptError(
        "record-corrupt",
        "Expired Workflow summary identity is incomplete"
      );
    }
    for (const reference of workflow.attemptRefs) {
      const key = attemptInventoryKey({
        workflowRunId,
        attemptId: reference.attemptId
      });
      if (!attempts.has(key) || !attemptTombstones.has(key)) {
        throw new RunRecordStoreCorruptError(
          "record-corrupt",
          "Expired Workflow summary has a live or missing Attempt summary"
        );
      }
    }
  }
}

function payloadHarnessRunId(
  payload: ConversationAttemptPayloadInventory
): string | null {
  if (payload.state === "present") return payload.manifest.harnessRunId;
  if (payload.state === "expired") {
    return payload.tombstone.harnessRunId ?? null;
  }
  return null;
}

function payloadInventoryDigest(
  payload: ConversationAttemptPayloadInventory | undefined
): string | undefined {
  if (!payload || payload.state === "missing") return undefined;
  if (payload.state === "present") return payload.manifest.digest;
  if (payload.state === "expired") return payload.tombstone.digest;
  return canonicalRunRecordDigest(payload);
}

function compareAttemptSummaries(
  left: AttemptRunSummaryV1,
  right: AttemptRunSummaryV1
): number {
  return left.ordinal - right.ordinal
    || left.attemptId.localeCompare(right.attemptId);
}

function compareInventoryBlockers(
  left: ConversationRunRecordInventoryBlocker,
  right: ConversationRunRecordInventoryBlocker
): number {
  return left.code.localeCompare(right.code)
    || left.workflowRunId.localeCompare(right.workflowRunId)
    || left.attemptId.localeCompare(right.attemptId);
}

function compareLocators(
  left: AttemptRunRecordLocator,
  right: AttemptRunRecordLocator
): number {
  return left.workflowRunId.localeCompare(right.workflowRunId)
    || left.attemptId.localeCompare(right.attemptId);
}

function attemptInventoryKey(locator: AttemptRunRecordLocator): string {
  return JSON.stringify([locator.workflowRunId, locator.attemptId]);
}

function parseAttemptInventoryKey(value: string): AttemptRunRecordLocator {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed)
    || parsed.length !== 2
    || !validSafeText(parsed[0], 512)
    || !validSafeText(parsed[1], 512)
  ) {
    throw new RunRecordStoreCorruptError(
      "record-corrupt",
      "Run record inventory key is invalid"
    );
  }
  return {
    workflowRunId: parsed[0],
    attemptId: parsed[1]
  };
}

function collectionDirectory(
  recordKind: RunRecordStoreRecordKind
): string {
  return recordKind === "workflow-summary"
    ? "workflow-summaries"
    : recordKind === "attempt-summary"
      ? "attempt-summaries"
      : "attempt-payloads";
}

function requireInventoryIdentity(value: string, label: string): string {
  if (!validSafeText(value, 512)) {
    throw new RunRecordStoreCorruptError(
      "record-corrupt",
      `Run record inventory ${label} is invalid`
    );
  }
  return value;
}

function validateAttemptPayloadUserDeletionProbe<T extends {
  workflowRunId: string;
  attemptId: string;
  forwardEffectId: string;
}>(input: T): T {
  requireInventoryIdentity(input.workflowRunId, "workflowRunId");
  requireInventoryIdentity(input.attemptId, "attemptId");
  requireInventoryIdentity(input.forwardEffectId, "forwardEffectId");
  return input;
}

function requireRunRecordTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RunRecordStoreConflictError(
      `Run record ${label} is invalid`
    );
  }
  return value;
}

function restoredAttemptPayloadManifest(
  prior: AttemptPayloadManifestV1,
  revision: number
): AttemptPayloadManifestV1 {
  const { digest: _digest, ...withoutDigest } = prior;
  const draft = {
    ...withoutDigest,
    revision
  };
  return validateAttemptPayloadManifest({
    ...draft,
    digest: canonicalRunRecordDigest(draft)
  });
}

function sameRestoredAttemptPayload(
  restored: AttemptPayloadManifestV1,
  prior: AttemptPayloadManifestV1,
  tombstone: RunRetentionTombstoneV1
): boolean {
  if (
    tombstone.scope !== "attempt-payload"
    || tombstone.reasonCode !== "user-deleted"
    || tombstone.workflowRunId !== prior.workflowRunId
    || tombstone.attemptId !== prior.attemptId
    || tombstone.harnessRunId !== prior.harnessRunId
    || tombstone.prior.digest !== prior.digest
  ) {
    return false;
  }
  return restored.digest
    === restoredAttemptPayloadManifest(prior, restored.revision).digest;
}

function assertInventoryGenerationIdentity(
  record: { revision: number; digest: string },
  manifest: RunRecordGenerationManifest
): void {
  if (
    record.revision !== manifest.revision
    || record.digest !== manifest.contentDigest
  ) {
    throw new RunRecordStoreCorruptError(
      "record-corrupt",
      "Run record inventory generation identity is inconsistent"
    );
  }
}

async function assertSafeGenerationDirectory(
  layout: SubjectLayout,
  manifest: RunRecordGenerationManifest,
  label: string
): Promise<void> {
  const generationStat = await lstatOrNull(path.join(
    layout.generationsPath,
    manifest.generation
  ));
  if (
    !generationStat
    || !generationStat.isDirectory()
    || generationStat.isSymbolicLink()
  ) {
    throw new RunRecordStoreCorruptError(
      generationStat ? "unsafe-path" : "generation-missing",
      `${label} Run record generation is missing or unsafe`
    );
  }
}

async function assertRecoveryOrphanMatches(
  current: Exclude<LatestManifestResult, { state: "corrupt" }>,
  input: PublishGenerationInput
): Promise<void> {
  const orphan = current.orphan;
  if (!orphan) {
    throw new RunRecordStoreCorruptError(
      "manifest-corrupt",
      "Run record recovery orphan is missing"
    );
  }
  const previousContentDigest = current.state === "present"
    ? current.manifest.contentDigest
    : null;
  if (
    orphan.recordKind !== input.recordKind
    || orphan.subjectToken !== safeRunRecordToken(input.subjectId)
    || orphan.revision !== input.revision
    || orphan.contentKind !== input.contentKind
    || orphan.contentDigest !== input.contentDigest
    || orphan.previousContentDigest !== previousContentDigest
  ) {
    throw new RunRecordStoreConflictError(
      `Run record revision ${input.revision} has a different recovery orphan`
    );
  }
  const generationPath = path.join(
    current.layout.generationsPath,
    orphan.generation
  );
  const entries = await readdir(generationPath, { withFileTypes: true });
  const expectedNames = input.files
    .map((file) => file.relativePath)
    .sort((left, right) => left.localeCompare(right));
  const actualNames = entries
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (
    !isDeepStrictEqual(actualNames, expectedNames)
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw new RunRecordStoreCorruptError(
      "generation-missing",
      "Run record recovery orphan generation files do not match its candidate"
    );
  }
  for (const file of input.files) {
    const existing = await readUtf8FileSafely(
      path.join(generationPath, file.relativePath),
      RUN_RECORD_MAX_PAYLOAD_BYTES
    );
    if (existing !== file.content) {
      throw new RunRecordStoreCorruptError(
        "record-corrupt",
        "Run record recovery orphan generation content is corrupt"
      );
    }
  }
}

function assertCas(
  current: Exclude<LatestManifestResult, { state: "corrupt" }>,
  cas: RunRecordStoreCas,
  candidateRevision: number
): void {
  if (
    !cas
    || !(
      cas.expectedRevision === null
      || (
        Number.isSafeInteger(cas.expectedRevision)
        && cas.expectedRevision >= 0
      )
    )
    || !(
      cas.expectedDigest === null
      || (
        typeof cas.expectedDigest === "string"
        && SHA256_PATTERN.test(cas.expectedDigest)
      )
    )
  ) {
    throw new RunRecordStoreConflictError("Invalid Run record CAS input");
  }
  if (current.state === "missing") {
    if (
      cas.expectedRevision !== null
      || cas.expectedDigest !== null
      || candidateRevision !== 0
    ) {
      throw new RunRecordStoreConflictError(
        "Run record CAS expected an existing revision, but no manifest exists"
      );
    }
    return;
  }
  if (
    cas.expectedRevision !== current.manifest.revision
    || cas.expectedDigest !== current.manifest.contentDigest
    || candidateRevision !== current.manifest.revision + 1
  ) {
    throw new RunRecordStoreConflictError(
      "Run record CAS revision or digest does not match the active manifest"
    );
  }
}

function assertReadableCurrent<T>(current: RunRecordStoreReadResult<T>): void {
  if (current.state === "corrupt") {
    throw new RunRecordStoreCorruptError(current.code, current.error);
  }
  if (current.state === "expired") {
    throw new RunRecordStoreConflictError(
      "Expired Run summary cannot be revived"
    );
  }
}

async function enqueueRunRecordStoreMutation<T>(
  rootPath: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = runRecordStoreMutationTails.get(rootPath)
    ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  runRecordStoreMutationTails.set(rootPath, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (runRecordStoreMutationTails.get(rootPath) === tail) {
      runRecordStoreMutationTails.delete(rootPath);
    }
  }
}

function assertWorkflowSummaryTransition(
  current: WorkflowRunSummaryV1,
  candidate: WorkflowRunSummaryV1
): void {
  if (
    current.workflowRunId !== candidate.workflowRunId
    || current.surface !== candidate.surface
    || current.workflow !== candidate.workflow
    || current.startedAt !== candidate.startedAt
    || !isDeepStrictEqual(current.conversationRef, candidate.conversationRef)
  ) {
    throw new RunRecordStoreConflictError(
      "Workflow Run summary immutable identity changed"
    );
  }
  if (!workflowStatusCanTransition(current.status, candidate.status)) {
    throw new RunRecordStoreConflictError(
      "Workflow Run summary status transition is not monotonic"
    );
  }
  if (current.status !== "running") {
    assertFieldsEqual(current, candidate, [
      "terminalAt",
      "usage",
      "errorCode"
    ], "Workflow Run terminal business fields");
  }
  assertAppendOnlyArray(
    current.attemptRefs,
    candidate.attemptRefs,
    "Workflow Run attemptRefs"
  );
  assertAppendOnlyArray(
    current.artifactRefs,
    candidate.artifactRefs,
    "Workflow Run artifactRefs"
  );
  assertLocalMutationTransition(
    current.localMutation,
    candidate.localMutation,
    "Workflow Run localMutation"
  );
}

function assertAttemptSummaryTransition(
  current: AttemptRunSummaryV1,
  candidate: AttemptRunSummaryV1
): void {
  if (
    current.workflowRunId !== candidate.workflowRunId
    || current.attemptId !== candidate.attemptId
    || current.ordinal !== candidate.ordinal
    || current.harnessRunId !== candidate.harnessRunId
    || current.backendId !== candidate.backendId
    || current.startedAt !== candidate.startedAt
  ) {
    throw new RunRecordStoreConflictError(
      "Attempt Run summary immutable identity changed"
    );
  }
  if (!attemptStatusCanTransition(current.status, candidate.status)) {
    throw new RunRecordStoreConflictError(
      "Attempt Run summary status transition is not monotonic"
    );
  }
  if (current.status !== "created" && current.status !== "running") {
    assertFieldsEqual(current, candidate, [
      "terminalAt",
      "usage",
      "errorCode",
      "reasonCode"
    ], "Attempt Run terminal business fields");
  }
  assertAppendOnlyArray(
    current.nativeExecutionRecordIds,
    candidate.nativeExecutionRecordIds,
    "Attempt Run nativeExecutionRecordIds"
  );
  assertLocalMutationTransition(
    current.localCommit,
    candidate.localCommit,
    "Attempt Run localCommit",
    "authorityKind"
  );
  assertCleanupTransition(current.cleanup, candidate.cleanup);
  if (current.payload.expected !== candidate.payload.expected) {
    throw new RunRecordStoreConflictError(
      "Attempt Run payload expected flag cannot change"
    );
  }
  assertOptionalAppendOnly(
    current.payload.manifestRef,
    candidate.payload.manifestRef,
    "Attempt Run payload manifestRef"
  );
  assertOptionalAppendOnly(
    current.payload.expiresAt,
    candidate.payload.expiresAt,
    "Attempt Run payload expiresAt"
  );
}

function workflowStatusCanTransition(
  current: WorkflowRunSummaryV1["status"],
  candidate: WorkflowRunSummaryV1["status"]
): boolean {
  if (current === "running") return true;
  if (current === "recovery-required") {
    return candidate === "recovery-required"
      || candidate === "completed"
      || candidate === "failed"
      || candidate === "cancelled"
      || candidate === "partial";
  }
  return candidate === current;
}

function attemptStatusCanTransition(
  current: AttemptRunSummaryV1["status"],
  candidate: AttemptRunSummaryV1["status"]
): boolean {
  if (current === "created") return true;
  if (current === "running") return candidate !== "created";
  if (current === "recovery-required") {
    return candidate === "recovery-required"
      || candidate === "completed"
      || candidate === "failed"
      || candidate === "cancelled";
  }
  return candidate === current;
}

function localMutationStateCanTransition(
  current: WorkflowRunSummaryV1["localMutation"]["state"],
  candidate: WorkflowRunSummaryV1["localMutation"]["state"]
): boolean {
  if (current === "pending") {
    return candidate === "pending"
      || candidate === "committed"
      || candidate === "aborted"
      || candidate === "recovery-required";
  }
  if (current === "recovery-required") {
    return candidate === "recovery-required"
      || candidate === "committed"
      || candidate === "aborted";
  }
  return candidate === current;
}

function assertLocalMutationTransition(
  current: WorkflowRunSummaryV1["localMutation"]
    | AttemptRunSummaryV1["localCommit"],
  candidate: WorkflowRunSummaryV1["localMutation"]
    | AttemptRunSummaryV1["localCommit"],
  label: string,
  identityKey: "transactionId" | "authorityKind" = "transactionId"
): void {
  if (!localMutationStateCanTransition(current.state, candidate.state)) {
    throw new RunRecordStoreConflictError(
      `${label} state transition is not monotonic`
    );
  }
  assertOptionalAppendOnly(
    identityKey === "transactionId"
      ? (current as WorkflowRunSummaryV1["localMutation"]).transactionId
      : (current as AttemptRunSummaryV1["localCommit"]).authorityKind,
    identityKey === "transactionId"
      ? (candidate as WorkflowRunSummaryV1["localMutation"]).transactionId
      : (candidate as AttemptRunSummaryV1["localCommit"]).authorityKind,
    `${label} ${identityKey}`
  );
  assertOptionalAppendOnly(
    current.committedAt,
    candidate.committedAt,
    `${label} committedAt`
  );
}

function cleanupStatusCanTransition(
  current: AttemptRunSummaryV1["cleanup"]["status"],
  candidate: AttemptRunSummaryV1["cleanup"]["status"]
): boolean {
  if (current === candidate) return true;
  if (current === "awaiting-local-commit") {
    return candidate === "pending"
      || candidate === "retained-for-recovery"
      || candidate === "retained"
      || candidate === "aborted"
      || candidate === "quarantined";
  }
  if (current === "pending") {
    return candidate === "disposing"
      || candidate === "disposed"
      || candidate === "unsupported"
      || candidate === "failed"
      || candidate === "retained"
      || candidate === "aborted"
      || candidate === "quarantined";
  }
  if (current === "disposing") {
    return candidate === "disposed"
      || candidate === "unsupported"
      || candidate === "failed"
      || candidate === "retained"
      || candidate === "aborted"
      || candidate === "quarantined";
  }
  if (current === "failed") {
    return candidate === "pending"
      || candidate === "disposing"
      || candidate === "disposed"
      || candidate === "unsupported"
      || candidate === "retained"
      || candidate === "aborted"
      || candidate === "quarantined";
  }
  if (current === "retained-for-recovery") {
    return candidate === "pending"
      || candidate === "retained"
      || candidate === "aborted"
      || candidate === "quarantined";
  }
  return false;
}

function assertCleanupTransition(
  current: AttemptRunSummaryV1["cleanup"],
  candidate: AttemptRunSummaryV1["cleanup"]
): void {
  if (!cleanupStatusCanTransition(current.status, candidate.status)) {
    throw new RunRecordStoreConflictError(
      "Attempt Run cleanup status transition is not monotonic"
    );
  }
  if (candidate.attempts < current.attempts) {
    throw new RunRecordStoreConflictError(
      "Attempt Run cleanup attempts cannot decrease"
    );
  }
  assertOptionalMonotonicTimestamp(
    current.nextAttemptAt,
    candidate.nextAttemptAt,
    "Attempt Run cleanup nextAttemptAt"
  );
  assertOptionalAppendOnly(
    current.settledAt,
    candidate.settledAt,
    "Attempt Run cleanup settledAt"
  );
  assertOptionalAppendOnly(
    current.quarantinedAt,
    candidate.quarantinedAt,
    "Attempt Run cleanup quarantinedAt"
  );
  assertOptionalAppendOnly(
    current.reasonCode,
    candidate.reasonCode,
    "Attempt Run cleanup reasonCode"
  );
}

function assertAppendOnlyArray<T>(
  current: readonly T[],
  candidate: readonly T[],
  label: string
): void {
  if (
    candidate.length < current.length
    || current.some((item, index) =>
      !isDeepStrictEqual(item, candidate[index])
    )
  ) {
    throw new RunRecordStoreConflictError(
      `${label} can only preserve its prefix and append`
    );
  }
}

function assertOptionalAppendOnly(
  current: unknown,
  candidate: unknown,
  label: string
): void {
  if (
    current !== undefined
    && (candidate === undefined || !isDeepStrictEqual(current, candidate))
  ) {
    throw new RunRecordStoreConflictError(
      `${label} cannot be removed or replaced`
    );
  }
}

function assertOptionalMonotonicTimestamp(
  current: number | undefined,
  candidate: number | undefined,
  label: string
): void {
  if (
    current !== undefined
    && (candidate === undefined || candidate < current)
  ) {
    throw new RunRecordStoreConflictError(
      `${label} cannot be removed or move backwards`
    );
  }
}

function assertFieldsEqual<T extends object>(
  current: T,
  candidate: T,
  fields: readonly (keyof T)[],
  label: string
): void {
  if (fields.some((field) =>
    !isDeepStrictEqual(current[field], candidate[field])
  )) {
    throw new RunRecordStoreConflictError(`${label} cannot be replaced`);
  }
}

async function writeRunRecordHeadAtomically(
  stagingRootPath: string,
  layout: SubjectLayout,
  manifest: RunRecordGenerationManifest
): Promise<void> {
  const head: RunRecordHeadV1 = {
    schemaVersion: 1,
    recordType: "run-record-head",
    recordKind: manifest.recordKind,
    subjectToken: manifest.subjectToken,
    revision: manifest.revision,
    manifestDigest: manifest.digest
  };
  const stagedPath = path.join(
    stagingRootPath,
    `.head-${manifest.subjectToken}-${randomUUID()}.tmp`
  );
  await writeNewFileDurably(stagedPath, jsonLine(head));
  try {
    await syncDirectory(stagingRootPath);
    await rename(stagedPath, layout.headPath);
    await syncDirectory(layout.subjectRootPath);
  } catch (error) {
    await unlink(stagedPath).catch(() => undefined);
    throw error;
  }
}

function validateRunRecordHead(value: unknown): RunRecordHeadV1 {
  const record = exactObject(value, [
    "schemaVersion",
    "recordType",
    "recordKind",
    "subjectToken",
    "revision",
    "manifestDigest"
  ]);
  if (
    record.schemaVersion !== 1
    || record.recordType !== "run-record-head"
    || ![
      "workflow-summary",
      "attempt-summary",
      "attempt-payload"
    ].includes(record.recordKind as string)
    || typeof record.subjectToken !== "string"
    || !/^[a-z0-9._-]+-[a-f0-9]{64}$/.test(record.subjectToken)
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || typeof record.manifestDigest !== "string"
    || !SHA256_PATTERN.test(record.manifestDigest)
  ) {
    throw new RunRecordStoreCorruptError(
      "manifest-corrupt",
      "Run record head is invalid"
    );
  }
  return record as unknown as RunRecordHeadV1;
}

function attemptRecordSubjectId(locator: AttemptRunRecordLocator): string {
  return runRecordSubjectDigest(
    "attempt-summary",
    locator.workflowRunId,
    locator.attemptId
  );
}

function validateGenerationManifest(
  value: unknown
): RunRecordGenerationManifest {
  const record = exactObject(value, [
    "schemaVersion",
    "recordType",
    "recordKind",
    "subjectToken",
    "revision",
    "generation",
    "contentKind",
    "contentDigest",
    "previousContentDigest",
    "committedAt",
    "digest"
  ]);
  if (
    record.schemaVersion !== 1
    || record.recordType !== "run-record-generation-manifest"
    || ![
      "workflow-summary",
      "attempt-summary",
      "attempt-payload"
    ].includes(record.recordKind as string)
    || typeof record.subjectToken !== "string"
    || !/^[a-z0-9._-]+-[a-f0-9]{64}$/.test(record.subjectToken)
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || typeof record.generation !== "string"
    || !/^\d{12}-[a-f0-9]{16}-[a-f0-9-]{36}$/.test(record.generation)
    || ![
      "record",
      "payload",
      "not-captured",
      "expired",
      "retired"
    ].includes(record.contentKind as string)
    || typeof record.contentDigest !== "string"
    || !SHA256_PATTERN.test(record.contentDigest)
    || !(
      record.previousContentDigest === null
      || (
        typeof record.previousContentDigest === "string"
        && SHA256_PATTERN.test(record.previousContentDigest)
      )
    )
    || !Number.isSafeInteger(record.committedAt)
    || (record.committedAt as number) < 0
    || typeof record.digest !== "string"
    || !SHA256_PATTERN.test(record.digest)
    || record.digest !== canonicalRunRecordDigest(record)
  ) {
    throw new RunRecordStoreCorruptError(
      "manifest-corrupt",
      "Run record generation manifest is invalid"
    );
  }
  return record as unknown as RunRecordGenerationManifest;
}

function validateNotCapturedRecord(
  value: unknown
): AttemptPayloadNotCapturedRecord {
  const record = exactObject(value, [
    "schemaVersion",
    "recordType",
    "workflowRunId",
    "attemptId",
    "harnessRunId",
    "subjectDigest",
    "reasonCode",
    "recordedAt",
    "revision",
    "digest"
  ]);
  if (
    record.schemaVersion !== 1
    || record.recordType !== "attempt-payload-not-captured"
    || !validSafeText(record.workflowRunId, 512)
    || !validSafeText(record.attemptId, 512)
    || !validSafeText(record.harnessRunId, 512)
    || typeof record.reasonCode !== "string"
    || !RUN_RECORD_REASON_CODES.includes(record.reasonCode as RunRecordReasonCode)
    || !CAPTURE_REASON_CODES.has(record.reasonCode as RunRecordReasonCode)
    || !Number.isSafeInteger(record.recordedAt)
    || (record.recordedAt as number) < 0
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || record.subjectDigest !== runRecordSubjectDigest(
      "attempt-payload",
      record.workflowRunId,
      record.attemptId,
      record.harnessRunId
    )
    || typeof record.digest !== "string"
    || !SHA256_PATTERN.test(record.digest)
    || record.digest !== canonicalRunRecordDigest(record)
  ) {
    throw new RunRecordStoreCorruptError(
      "not-captured-corrupt",
      "Attempt payload not-captured record is invalid"
    );
  }
  return record as unknown as AttemptPayloadNotCapturedRecord;
}

function exactObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Expected JSON object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unexpected field ${key}`);
  }
  return record;
}

function validSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !containsControlCharacter(value);
}

function withDigest<T extends object>(input: T): T & { digest: string } {
  return {
    ...input,
    digest: canonicalRunRecordDigest(input)
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readUtf8FileSafely(filePath, 64 * 1024 * 1024)) as unknown;
}

async function readUtf8FileSafely(
  filePath: string,
  maxBytes: number
): Promise<string> {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | noFollowFlag()
  );
  try {
    const before = await handle.stat();
    assertSafeRegularFile(before, filePath, [1, 2]);
    if (before.size > maxBytes) {
      throw new RunRecordStoreCorruptError(
        "unsafe-path",
        `Run record file exceeds safe byte limit: ${filePath}`
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileVersion(before, after) || bytes.byteLength !== before.size) {
      throw new RunRecordStoreCorruptError(
        "unsafe-path",
        `Run record file changed during read: ${filePath}`
      );
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeNewFileDurably(
  filePath: string,
  content: string
): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | noFollowFlag(),
    0o600
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePlainDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RunRecordStoreCorruptError(
      "unsafe-path",
      `Expected plain directory: ${directoryPath}`
    );
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(
    directoryPath,
    fsConstants.O_RDONLY | noFollowFlag()
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertSafeRegularFile(
  stat: Stats,
  label: string,
  allowedLinkCounts: readonly number[]
): void {
  if (!stat.isFile() || !allowedLinkCounts.includes(Number(stat.nlink))) {
    throw new RunRecordStoreCorruptError(
      "unsafe-path",
      `Run record file is not a safe regular file: ${label}`
    );
  }
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function noFollowFlag(): number {
  return (
    (fsConstants as unknown as Record<string, number>).O_NOFOLLOW
    ?? 0
  );
}

async function lstatOrNull(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function manifestFileName(revision: number): string {
  return `${String(revision).padStart(12, "0")}.json`;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function corruptLatest(
  layout: SubjectLayout,
  code: RunRecordStoreCorruptCode,
  error: string
): LatestManifestResult {
  return { state: "corrupt", layout, code, error };
}

function corruptResult(
  code: RunRecordStoreCorruptCode,
  error: unknown
): { state: "corrupt"; code: RunRecordStoreCorruptCode; error: string } {
  return {
    state: "corrupt",
    code,
    error: errorMessage(error)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
