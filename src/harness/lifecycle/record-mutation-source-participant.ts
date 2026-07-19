import {
  parseRecordMutationIntent,
  recordMutationDigest,
  type RecordMutationParticipant,
  type RecordMutationRecordKind
} from "./record-mutation-contract";
import {
  beginRecordMutationCompensation,
  loadRecordMutationJournal,
  stageRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "./record-mutation-journal";
import {
  parseRecordRootBindingRef,
  sameRecordRootBindingRef,
  verifyRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";

const SOURCE_PARTICIPANT_RECEIPT_SCHEMA_VERSION = 1 as const;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type RecordMutationSourceParticipantKind = Extract<
  RecordMutationRecordKind,
  "memory" | "artifact"
>;

export interface RecordMutationSourceParticipantReceipt {
  schemaVersion: typeof SOURCE_PARTICIPANT_RECEIPT_SCHEMA_VERSION;
  kind: "record-mutation-source-participant-receipt";
  mutationId: string;
  conversationId: string;
  participantId: string;
  recordKind: RecordMutationSourceParticipantKind;
  phase: "source-deleted" | "source-restored";
  effectId: string;
  effectDigest: string;
  occurredAt: number;
  digest: string;
}

export type RecordMutationSourceParticipantObservation =
  | { status: "before" }
  | {
      status: "source-deleted";
      forwardReceipt: RecordMutationSourceParticipantReceipt;
    }
  | {
      status: "source-restored";
      forwardReceipt: RecordMutationSourceParticipantReceipt;
      restoreReceipt: RecordMutationSourceParticipantReceipt;
    };

export interface RecordMutationSourceParticipantAdapter {
  participantId: string;
  recordKind: RecordMutationSourceParticipantKind;
  storageRootPath: string;
  rootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
  withMutation<T>(action: () => Promise<T>): Promise<T>;
  recover(): Promise<void>;
  inspect(input: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  }): Promise<RecordMutationSourceParticipantObservation>;
  stage(input: {
    mutationId: string;
    conversationId: string;
    participantId: string;
    occurredAt: number;
  }): Promise<RecordMutationSourceParticipantReceipt>;
  restore(input: {
    mutationId: string;
    conversationId: string;
    participantId: string;
    forwardReceipt: RecordMutationSourceParticipantReceipt;
    occurredAt: number;
  }): Promise<RecordMutationSourceParticipantReceipt>;
}

export type RecordMutationSourceParticipantErrorCode =
  | "participant_mismatch"
  | "receipt_corrupt"
  | "effect_conflict"
  | "authority_mismatch";

export class RecordMutationSourceParticipantError extends Error {
  constructor(
    public readonly code: RecordMutationSourceParticipantErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RecordMutationSourceParticipantError";
  }
}

export function createRecordMutationSourceParticipantReceipt(input: {
  mutationId: string;
  conversationId: string;
  participantId: string;
  recordKind: RecordMutationSourceParticipantKind;
  phase: "source-deleted" | "source-restored";
  effectId: string;
  effectDigest: string;
  occurredAt: number;
}): RecordMutationSourceParticipantReceipt {
  const draft = {
    schemaVersion: SOURCE_PARTICIPANT_RECEIPT_SCHEMA_VERSION,
    kind: "record-mutation-source-participant-receipt" as const,
    mutationId: requireSafeId(input.mutationId, "mutationId"),
    conversationId: requireSafeId(input.conversationId, "conversationId"),
    participantId: requireSafeId(input.participantId, "participantId"),
    recordKind: requireSourceParticipantKind(input.recordKind),
    phase: requirePhase(input.phase),
    effectId: requireSafeId(input.effectId, "effectId"),
    effectDigest: requireDigest(input.effectDigest, "effectDigest"),
    occurredAt: requireTimestamp(input.occurredAt, "occurredAt")
  };
  return parseRecordMutationSourceParticipantReceipt({
    ...draft,
    digest: recordMutationDigest(draft)
  });
}

export function parseRecordMutationSourceParticipantReceipt(
  value: unknown
): RecordMutationSourceParticipantReceipt {
  const record = requirePlainRecord(value, "source participant receipt");
  assertExactKeys(record, [
    "schemaVersion",
    "kind",
    "mutationId",
    "conversationId",
    "participantId",
    "recordKind",
    "phase",
    "effectId",
    "effectDigest",
    "occurredAt",
    "digest"
  ], "source participant receipt");
  if (record.schemaVersion !== SOURCE_PARTICIPANT_RECEIPT_SCHEMA_VERSION) {
    throw receiptCorrupt("source participant receipt schemaVersion 非法");
  }
  if (record.kind !== "record-mutation-source-participant-receipt") {
    throw receiptCorrupt("source participant receipt kind 非法");
  }
  const parsed: RecordMutationSourceParticipantReceipt = {
    schemaVersion: SOURCE_PARTICIPANT_RECEIPT_SCHEMA_VERSION,
    kind: "record-mutation-source-participant-receipt",
    mutationId: requireSafeId(record.mutationId, "mutationId"),
    conversationId: requireSafeId(record.conversationId, "conversationId"),
    participantId: requireSafeId(record.participantId, "participantId"),
    recordKind: requireSourceParticipantKind(record.recordKind),
    phase: requirePhase(record.phase),
    effectId: requireSafeId(record.effectId, "effectId"),
    effectDigest: requireDigest(record.effectDigest, "effectDigest"),
    occurredAt: requireTimestamp(record.occurredAt, "occurredAt"),
    digest: requireDigest(record.digest, "digest")
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (parsed.digest !== recordMutationDigest(withoutDigest)) {
    throw receiptCorrupt("source participant receipt digest 不匹配");
  }
  return parsed;
}

export function validateRecordMutationSourceParticipants(
  journal: LoadedRecordMutationJournal,
  input: unknown
): RecordMutationSourceParticipantAdapter[] {
  if (
    !Array.isArray(input)
    || !input.every(isRecordMutationSourceParticipantAdapter)
  ) {
    throw participantMismatch("sourceDeletedParticipants 非法");
  }
  const adapters = input;
  const expected = journal.record.intent.participants
    .filter((participant) => participant.action === "mark-source-deleted");
  if (
    adapters.length !== expected.length
    || adapters.some((adapter, index) => (
      adapter.participantId !== expected[index]?.id
      || adapter.recordKind !== expected[index]?.recordKind
    ))
    || new Set(adapters.map((adapter) => adapter.participantId)).size
      !== adapters.length
  ) {
    throw participantMismatch(
      "sourceDeletedParticipants 必须与 intent 完整同序"
    );
  }
  return [...adapters];
}

function isRecordMutationSourceParticipantAdapter(
  value: unknown
): value is RecordMutationSourceParticipantAdapter {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const adapter = value as Record<string, unknown>;
  return typeof adapter.participantId === "string"
    && (adapter.recordKind === "memory" || adapter.recordKind === "artifact")
    && typeof adapter.storageRootPath === "string"
    && typeof adapter.rootPath === "string"
    && typeof adapter.boundaryRootPath === "string"
    && typeof adapter.rootBinding === "object"
    && adapter.rootBinding !== null
    && typeof adapter.withMutation === "function"
    && typeof adapter.recover === "function"
    && typeof adapter.inspect === "function"
    && typeof adapter.stage === "function"
    && typeof adapter.restore === "function";
}

export async function coordinateRecordMutationSourceParticipantForward(input: {
  journal: LoadedRecordMutationJournal;
  adapter: RecordMutationSourceParticipantAdapter;
  now?: () => number;
}): Promise<LoadedRecordMutationJournal> {
  return await input.adapter.withMutation(async () => {
    let current = await loadVerifyRecoverAndReverify(
      input.journal,
      input.adapter
    );
    const identity = participantIdentity(current, input.adapter);
    let observation = await inspectAndParse(input.adapter, identity);
    if (observation.status === "source-restored") {
      throw effectConflict(
        `participant ${input.adapter.participantId} 已由同一 mutation 恢复`
      );
    }
    let receipt = observation.status === "before"
      ? parseRecordMutationSourceParticipantReceipt(
        await input.adapter.stage({
          ...identity,
          occurredAt: nextTimestamp(current, input.now)
        })
      )
      : observation.forwardReceipt;
    assertReceiptMatches(receipt, identity, input.adapter, "source-deleted");
    observation = await inspectAndParse(input.adapter, identity);
    if (
      observation.status !== "source-deleted"
      || observation.forwardReceipt.digest !== receipt.digest
    ) {
      throw effectConflict(
        `participant ${input.adapter.participantId} forward readback 不一致`
      );
    }
    const existing = participantStep(
      current,
      input.adapter.participantId,
      "forward",
      "participant-staged"
    );
    if (existing) {
      if (existing.evidenceDigest !== receipt.digest) {
        throw effectConflict(
          `participant ${input.adapter.participantId} forward evidence 冲突`
        );
      }
      return current;
    }
    if (current.record.state !== "staged") {
      throw effectConflict("source participant forward 只能追加到 staged Journal");
    }
    current = await stageRecordMutationJournal(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      step: {
        direction: "forward",
        ordinal: nextDirectionOrdinal(current, "forward"),
        participantId: input.adapter.participantId,
        action: "participant-staged",
        evidenceDigest: receipt.digest
      },
      updatedAt: nextTimestamp(current, input.now)
    });
    return current;
  });
}

export async function reconcileRecordMutationSourceParticipantForward(input: {
  journal: LoadedRecordMutationJournal;
  adapter: RecordMutationSourceParticipantAdapter;
  now?: () => number;
}): Promise<LoadedRecordMutationJournal> {
  return await input.adapter.withMutation(async () => {
    let current = await loadVerifyRecoverAndReverify(
      input.journal,
      input.adapter
    );
    const identity = participantIdentity(current, input.adapter);
    const observation = await inspectAndParse(input.adapter, identity);
    if (observation.status === "before") return current;
    if (observation.status === "source-restored") {
      throw effectConflict(
        `participant ${input.adapter.participantId} restore 先于 Journal compensation`
      );
    }
    const receipt = observation.forwardReceipt;
    assertReceiptMatches(receipt, identity, input.adapter, "source-deleted");
    const existing = participantStep(
      current,
      input.adapter.participantId,
      "forward",
      "participant-staged"
    );
    if (existing) {
      if (existing.evidenceDigest !== receipt.digest) {
        throw effectConflict(
          `participant ${input.adapter.participantId} forward evidence 冲突`
        );
      }
      return current;
    }
    if (current.record.state !== "staged") {
      throw effectConflict(
        "source participant forward crash window 只能在 staged 收口"
      );
    }
    current = await stageRecordMutationJournal(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      step: {
        direction: "forward",
        ordinal: nextDirectionOrdinal(current, "forward"),
        participantId: input.adapter.participantId,
        action: "participant-staged",
        evidenceDigest: receipt.digest
      },
      updatedAt: nextTimestamp(current, input.now)
    });
    return current;
  });
}

export async function verifyRecordMutationSourceParticipantForward(input: {
  journal: LoadedRecordMutationJournal;
  adapter: RecordMutationSourceParticipantAdapter;
}): Promise<LoadedRecordMutationJournal> {
  return await input.adapter.withMutation(async () => {
    const current = await loadVerifyRecoverAndReverify(
      input.journal,
      input.adapter
    );
    const identity = participantIdentity(current, input.adapter);
    const observation = await inspectAndParse(input.adapter, identity);
    const existing = participantStep(
      current,
      input.adapter.participantId,
      "forward",
      "participant-staged"
    );
    if (
      !existing
      || observation.status !== "source-deleted"
      || observation.forwardReceipt.digest !== existing.evidenceDigest
    ) {
      throw effectConflict(
        `participant ${input.adapter.participantId} forward proof 已变化`
      );
    }
    return current;
  });
}

export async function verifyRecordMutationSourceParticipantAborted(input: {
  journal: LoadedRecordMutationJournal;
  adapter: RecordMutationSourceParticipantAdapter;
}): Promise<LoadedRecordMutationJournal> {
  return await input.adapter.withMutation(async () => {
    const current = await loadVerifyRecoverAndReverify(
      input.journal,
      input.adapter
    );
    const identity = participantIdentity(current, input.adapter);
    const observation = await inspectAndParse(input.adapter, identity);
    const forward = participantStep(
      current,
      input.adapter.participantId,
      "forward",
      "participant-staged"
    );
    if (!forward) {
      if (observation.status !== "before") {
        throw effectConflict(
          `participant ${input.adapter.participantId} aborted 前出现未记账 effect`
        );
      }
      return current;
    }
    const restored = participantStep(
      current,
      input.adapter.participantId,
      "compensating",
      "participant-restored"
    );
    const compensationPrepared = participantStep(
      current,
      input.adapter.participantId,
      "compensating",
      "compensation-prepared"
    );
    if (
      !restored
      || !compensationPrepared
      || observation.status !== "source-restored"
      || observation.forwardReceipt.digest !== forward.evidenceDigest
      || compensationPrepared.evidenceDigest !== forward.evidenceDigest
      || observation.restoreReceipt.digest !== restored.evidenceDigest
    ) {
      throw effectConflict(
        `participant ${input.adapter.participantId} aborted proof 不完整`
      );
    }
    return current;
  });
}

export async function coordinateRecordMutationSourceParticipantRestore(input: {
  journal: LoadedRecordMutationJournal;
  adapter: RecordMutationSourceParticipantAdapter;
  now?: () => number;
}): Promise<LoadedRecordMutationJournal> {
  return await input.adapter.withMutation(async () => {
    let current = await loadVerifyRecoverAndReverify(
      input.journal,
      input.adapter
    );
    const identity = participantIdentity(current, input.adapter);
    const compensationPrepared = participantStep(
      current,
      input.adapter.participantId,
      "compensating",
      "compensation-prepared"
    );
    if (current.record.state !== "compensating" || !compensationPrepared) {
      throw effectConflict(
        `participant ${input.adapter.participantId} restore 缺少 compensation-prepared`
      );
    }
    let observation = await inspectAndParse(input.adapter, identity);
    if (observation.status === "before") {
      throw effectConflict(
        `participant ${input.adapter.participantId} 缺少 durable forward proof`
      );
    }
    const forwardReceipt = observation.forwardReceipt;
    assertReceiptMatches(
      forwardReceipt,
      identity,
      input.adapter,
      "source-deleted"
    );
    const forwardStep = participantStep(
      current,
      input.adapter.participantId,
      "forward",
      "participant-staged"
    );
    if (!forwardStep || forwardStep.evidenceDigest !== forwardReceipt.digest) {
      throw effectConflict(
        `participant ${input.adapter.participantId} forward Journal proof 不匹配`
      );
    }
    if (compensationPrepared.evidenceDigest !== forwardReceipt.digest) {
      throw effectConflict(
        `participant ${input.adapter.participantId} compensation proof 不匹配`
      );
    }
    const restoreReceipt = observation.status === "source-restored"
      ? observation.restoreReceipt
      : parseRecordMutationSourceParticipantReceipt(
        await input.adapter.restore({
          ...identity,
          forwardReceipt,
          occurredAt: nextTimestamp(current, input.now)
        })
      );
    assertReceiptMatches(
      restoreReceipt,
      identity,
      input.adapter,
      "source-restored"
    );
    observation = await inspectAndParse(input.adapter, identity);
    if (
      observation.status !== "source-restored"
      || observation.forwardReceipt.digest !== forwardReceipt.digest
      || observation.restoreReceipt.digest !== restoreReceipt.digest
    ) {
      throw effectConflict(
        `participant ${input.adapter.participantId} restore readback 不一致`
      );
    }
    const existing = participantStep(
      current,
      input.adapter.participantId,
      "compensating",
      "participant-restored"
    );
    if (existing) {
      if (existing.evidenceDigest !== restoreReceipt.digest) {
        throw effectConflict(
          `participant ${input.adapter.participantId} restore evidence 冲突`
        );
      }
      return current;
    }
    current = await beginRecordMutationCompensation(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      step: {
        direction: "compensating",
        ordinal: nextDirectionOrdinal(current, "compensating"),
        participantId: input.adapter.participantId,
        action: "participant-restored",
        evidenceDigest: restoreReceipt.digest
      },
      updatedAt: nextTimestamp(current, input.now)
    });
    return current;
  });
}

function participantIdentity(
  journal: LoadedRecordMutationJournal,
  adapter: RecordMutationSourceParticipantAdapter
): {
  mutationId: string;
  conversationId: string;
  participantId: string;
} {
  return {
    mutationId: journal.record.mutationId,
    conversationId: journal.record.intent.conversationId,
    participantId: adapter.participantId
  };
}

async function loadAndVerify(
  journal: LoadedRecordMutationJournal,
  adapter: RecordMutationSourceParticipantAdapter
): Promise<LoadedRecordMutationJournal> {
  const current = await loadRecordMutationJournal(journal.handle);
  if (current.record.mutationId !== journal.record.mutationId) {
    throw participantMismatch("source participant Journal identity 已变化");
  }
  const intent = parseRecordMutationIntent(current.record.intent);
  const participant = intent.participants.find(
    (candidate) => candidate.id === adapter.participantId
  );
  assertAdapterParticipant(participant, adapter);
  const binding = parseRecordRootBindingRef(adapter.rootBinding);
  if (
    !intent.rootBindings.some((candidate) => (
      sameRecordRootBindingRef(candidate, binding)
    ))
  ) {
    throw authorityMismatch(
      `participant ${adapter.participantId} root binding 不在 frozen intent`
    );
  }
  await verifyRecordRootBindingRef(binding, {
    storageRootPath: adapter.storageRootPath,
    rootPath: adapter.rootPath,
    boundaryRootPath: adapter.boundaryRootPath
  });
  return current;
}

async function loadVerifyRecoverAndReverify(
  journal: LoadedRecordMutationJournal,
  adapter: RecordMutationSourceParticipantAdapter
): Promise<LoadedRecordMutationJournal> {
  const current = await loadAndVerify(journal, adapter);
  await adapter.recover();
  return await loadAndVerify(current, adapter);
}

function assertAdapterParticipant(
  participant: RecordMutationParticipant | undefined,
  adapter: RecordMutationSourceParticipantAdapter
): void {
  if (
    !participant
    || participant.action !== "mark-source-deleted"
    || participant.recordKind !== adapter.recordKind
  ) {
    throw participantMismatch(
      `source participant ${adapter.participantId} 与 intent 不匹配`
    );
  }
}

async function inspectAndParse(
  adapter: RecordMutationSourceParticipantAdapter,
  identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  }
): Promise<RecordMutationSourceParticipantObservation> {
  const observation = await adapter.inspect(identity);
  if (observation.status === "before") return observation;
  const forwardReceipt = parseRecordMutationSourceParticipantReceipt(
    observation.forwardReceipt
  );
  assertReceiptMatches(
    forwardReceipt,
    identity,
    adapter,
    "source-deleted"
  );
  if (observation.status === "source-deleted") {
    return { status: "source-deleted", forwardReceipt };
  }
  if (observation.status !== "source-restored") {
    throw effectConflict("source participant observation status 非法");
  }
  const restoreReceipt = parseRecordMutationSourceParticipantReceipt(
    observation.restoreReceipt
  );
  assertReceiptMatches(
    restoreReceipt,
    identity,
    adapter,
    "source-restored"
  );
  return { status: "source-restored", forwardReceipt, restoreReceipt };
}

function assertReceiptMatches(
  receipt: RecordMutationSourceParticipantReceipt,
  identity: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  },
  adapter: RecordMutationSourceParticipantAdapter,
  phase: RecordMutationSourceParticipantReceipt["phase"]
): void {
  if (
    receipt.mutationId !== identity.mutationId
    || receipt.conversationId !== identity.conversationId
    || receipt.participantId !== identity.participantId
    || receipt.recordKind !== adapter.recordKind
    || receipt.phase !== phase
  ) {
    throw effectConflict(
      `participant ${adapter.participantId} receipt identity 不匹配`
    );
  }
}

function participantStep(
  journal: LoadedRecordMutationJournal,
  participantId: string,
  direction: "forward" | "compensating",
  action:
    | "participant-staged"
    | "compensation-prepared"
    | "participant-restored"
): NonNullable<LoadedRecordMutationJournal["record"]["step"]> | null {
  return journal.chain.find((revision) => (
    revision.step?.participantId === participantId
    && revision.step.direction === direction
    && revision.step.action === action
  ))?.step ?? null;
}

function nextDirectionOrdinal(
  journal: LoadedRecordMutationJournal,
  direction: "forward" | "compensating"
): number {
  const ordinals = journal.chain.flatMap((revision) => (
    revision.step?.direction === direction ? [revision.step.ordinal] : []
  ));
  return (ordinals.length ? Math.max(...ordinals) : 0) + 1;
}

function nextTimestamp(
  journal: LoadedRecordMutationJournal,
  now: (() => number) | undefined
): number {
  const candidate = now ? now() : Date.now();
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw effectConflict("source participant clock 非法");
  }
  return Math.max(candidate, journal.record.updatedAt + 1);
}

function requireSourceParticipantKind(
  value: unknown
): RecordMutationSourceParticipantKind {
  if (value !== "memory" && value !== "artifact") {
    throw receiptCorrupt("source participant recordKind 非法");
  }
  return value;
}

function requirePhase(
  value: unknown
): RecordMutationSourceParticipantReceipt["phase"] {
  if (value !== "source-deleted" && value !== "source-restored") {
    throw receiptCorrupt("source participant phase 非法");
  }
  return value;
}

function requireSafeId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_ID_PATTERN.test(value)
    || value !== value.normalize("NFC")
  ) {
    throw receiptCorrupt(`${label} 非法`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw receiptCorrupt(`${label} 非法`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw receiptCorrupt(`${label} 非法`);
  }
  return Number(value);
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw receiptCorrupt(`${label} 必须是 plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw receiptCorrupt(`${label} 字段集合非法`);
  }
}

function participantMismatch(message: string): RecordMutationSourceParticipantError {
  return new RecordMutationSourceParticipantError(
    "participant_mismatch",
    message
  );
}

function receiptCorrupt(message: string): RecordMutationSourceParticipantError {
  return new RecordMutationSourceParticipantError("receipt_corrupt", message);
}

function effectConflict(message: string): RecordMutationSourceParticipantError {
  return new RecordMutationSourceParticipantError("effect_conflict", message);
}

function authorityMismatch(message: string): RecordMutationSourceParticipantError {
  return new RecordMutationSourceParticipantError(
    "authority_mismatch",
    message
  );
}
