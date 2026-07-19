import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  beginRecordMutationCompensation,
  commitRecordMutationJournal,
  finalizeRecordMutationAbort,
  loadRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "./record-mutation-journal";
import {
  parseRecordMutationIntent,
  parseRecordMutationRootBindings,
  parseRecordMutationRevision,
  type RecordMutationIntent,
  type RecordMutationRevision
} from "./record-mutation-contract";
import {
  sameRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  parseRecordMutationTrashReceipt,
  restoreRecordMutationTrash,
  type RecordMutationTrashReceipt
} from "./record-mutation-trash";

const RECOVERY_EVIDENCE_SCHEMA_VERSION = 2;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface RecordMutationRecoveryEvidence {
  schemaVersion: typeof RECOVERY_EVIDENCE_SCHEMA_VERSION;
  kind: "record-mutation-recovery-evidence";
  mutationId: string;
  intentDigest: string;
  rootBindings: RecordRootBindingRef[];
  conversation: RecordMutationConversationObservation;
  trash:
    | "not-required"
    | "recoverable"
    | "missing"
    | "corrupt"
    | "unknown";
}

export type RecordMutationConversationObservation =
  | {
      status: "present";
      generation: number;
      commitId: string | null;
      contentRevision: string;
    }
  | {
      status: "deleted";
      tombstoneId: string;
      digest: string;
    }
  | { status: "missing" }
  | { status: "unknown" };

export type RecordMutationLocalCommitClassification =
  | "exact-target"
  | "before-target"
  | "contradictory"
  | "unknown";

export type RecordMutationRecoveryDecision =
  | {
      action: "none";
      reason: "already-committed" | "already-aborted";
    }
  | {
      action: "roll-forward";
      reason: "exact-local-commit";
    }
  | {
      action: "compensate";
      reason: "local-commit-absent";
    }
  | {
      action: "blocked";
      reason:
        | "identity-mismatch"
        | "root-binding-mismatch"
        | "trash-policy-mismatch"
        | "planned-without-stage"
        | "contradictory-local-commit"
        | "unknown-local-commit"
        | "terminal-evidence-conflict"
        | "trash-evidence-unavailable"
        | "compensation-conflicts-with-local-commit";
    };

export class RecordMutationRecoveryError extends Error {
  constructor(
    public readonly code:
      | "evidence_corrupt"
      | "fixture_only"
      | "recovery_blocked",
    message: string
  ) {
    super(message);
    this.name = "RecordMutationRecoveryError";
  }
}

export function parseRecordMutationRecoveryEvidence(
  value: unknown
): RecordMutationRecoveryEvidence {
  const record = requirePlainRecord(value);
  assertExactKeys(record, [
    "schemaVersion",
    "kind",
    "mutationId",
    "intentDigest",
    "rootBindings",
    "conversation",
    "trash"
  ]);
  if (record.schemaVersion !== RECOVERY_EVIDENCE_SCHEMA_VERSION) {
    throw evidenceCorrupt(
      `recovery evidence schema 不受支持：${String(record.schemaVersion)}`
    );
  }
  if (record.kind !== "record-mutation-recovery-evidence") {
    throw evidenceCorrupt("recovery evidence kind 非法");
  }
  if (
    typeof record.mutationId !== "string"
    || !SAFE_ID_PATTERN.test(record.mutationId)
    || record.mutationId !== record.mutationId.normalize("NFC")
  ) {
    throw evidenceCorrupt("recovery evidence mutationId 非法");
  }
  if (
    typeof record.intentDigest !== "string"
    || !SHA256_PATTERN.test(record.intentDigest)
  ) {
    throw evidenceCorrupt("recovery evidence intentDigest 非法");
  }
  let rootBindings: RecordRootBindingRef[];
  try {
    rootBindings = parseRecordMutationRootBindings(record.rootBindings);
  } catch {
    throw evidenceCorrupt("recovery evidence rootBindings 非法");
  }
  const conversation = parseRecordMutationConversationObservation(
    record.conversation
  );
  if (
    record.trash !== "not-required"
    && record.trash !== "recoverable"
    && record.trash !== "missing"
    && record.trash !== "corrupt"
    && record.trash !== "unknown"
  ) {
    throw evidenceCorrupt("recovery evidence trash 非法");
  }
  return {
    schemaVersion: RECOVERY_EVIDENCE_SCHEMA_VERSION,
    kind: "record-mutation-recovery-evidence",
    mutationId: record.mutationId,
    intentDigest: record.intentDigest,
    rootBindings,
    conversation,
    trash: record.trash
  };
}

export function parseRecordMutationConversationObservation(
  value: unknown
): RecordMutationConversationObservation {
  const record = requirePlainRecord(value);
  if (record.status === "present") {
    assertExactKeys(record, [
      "status",
      "generation",
      "commitId",
      "contentRevision"
    ]);
    if (
      !Number.isSafeInteger(record.generation)
      || Number(record.generation) < 0
      || (
        record.commitId !== null
        && (
          typeof record.commitId !== "string"
          || !SAFE_ID_PATTERN.test(record.commitId)
          || record.commitId !== record.commitId.normalize("NFC")
        )
      )
      || typeof record.contentRevision !== "string"
      || !SHA256_PATTERN.test(record.contentRevision)
    ) {
      throw evidenceCorrupt("Conversation present observation 非法");
    }
    return {
      status: "present",
      generation: Number(record.generation),
      commitId: record.commitId,
      contentRevision: record.contentRevision
    };
  }
  if (record.status === "deleted") {
    assertExactKeys(record, ["status", "tombstoneId", "digest"]);
    if (
      typeof record.tombstoneId !== "string"
      || !SAFE_ID_PATTERN.test(record.tombstoneId)
      || record.tombstoneId !== record.tombstoneId.normalize("NFC")
      || typeof record.digest !== "string"
      || !SHA256_PATTERN.test(record.digest)
    ) {
      throw evidenceCorrupt("Conversation deleted observation 非法");
    }
    return {
      status: "deleted",
      tombstoneId: record.tombstoneId,
      digest: record.digest
    };
  }
  if (record.status === "missing" || record.status === "unknown") {
    assertExactKeys(record, ["status"]);
    return { status: record.status };
  }
  throw evidenceCorrupt("Conversation observation status 非法");
}

export function classifyRecordMutationLocalCommit(
  intentInput: RecordMutationIntent,
  observationInput: RecordMutationConversationObservation
): RecordMutationLocalCommitClassification {
  const intent = parseRecordMutationIntent(intentInput);
  const observation = parseRecordMutationConversationObservation(
    observationInput
  );
  if (observation.status === "missing" || observation.status === "unknown") {
    return "unknown";
  }
  if (intent.targetConversation.status === "present") {
    if (
      observation.status === "present"
      && observation.generation === intent.targetConversation.generation
      && observation.commitId === intent.targetConversation.commitId
      && observation.contentRevision === intent.targetConversation.contentRevision
    ) {
      return "exact-target";
    }
  } else if (
    observation.status === "deleted"
    && observation.tombstoneId === intent.targetConversation.tombstoneId
    && observation.digest === intent.targetConversation.digest
  ) {
    return "exact-target";
  }
  if (
    observation.status === "present"
    && observation.generation === intent.expectedConversationGeneration
    && observation.commitId === intent.expectedConversationCommitId
    && observation.contentRevision
      === intent.expectedConversationContentRevision
  ) {
    return "before-target";
  }
  return "contradictory";
}

/**
 * Pure recovery decision. It does not inspect or mutate Conversation, Memory,
 * Run, Artifact, Raw, or Native stores.
 */
export function decideRecordMutationRecovery(
  recordInput: RecordMutationRevision,
  evidenceInput: RecordMutationRecoveryEvidence
): RecordMutationRecoveryDecision {
  const record = parseRecordMutationRevision(recordInput);
  const evidence = parseRecordMutationRecoveryEvidence(evidenceInput);
  const localCommit = classifyRecordMutationLocalCommit(
    record.intent,
    evidence.conversation
  );
  if (
    record.mutationId !== evidence.mutationId
    || record.intentDigest !== evidence.intentDigest
  ) {
    return { action: "blocked", reason: "identity-mismatch" };
  }
  if (!sameRootBindingSet(record.intent.rootBindings, evidence.rootBindings)) {
    return { action: "blocked", reason: "root-binding-mismatch" };
  }
  if (
    (record.intent.trashPolicy === "required" && evidence.trash === "not-required")
    || (
      record.intent.trashPolicy === "not-required"
      && evidence.trash !== "not-required"
    )
  ) {
    return { action: "blocked", reason: "trash-policy-mismatch" };
  }
  if (
    record.intent.trashPolicy === "required"
    && evidence.trash !== "recoverable"
  ) {
    return { action: "blocked", reason: "trash-evidence-unavailable" };
  }
  if (localCommit === "contradictory") {
    return { action: "blocked", reason: "contradictory-local-commit" };
  }
  if (localCommit === "unknown") {
    return { action: "blocked", reason: "unknown-local-commit" };
  }
  if (record.state === "committed") {
    return localCommit === "exact-target"
      ? { action: "none", reason: "already-committed" }
      : { action: "blocked", reason: "terminal-evidence-conflict" };
  }
  if (record.state === "aborted") {
    return localCommit === "before-target"
      ? { action: "none", reason: "already-aborted" }
      : { action: "blocked", reason: "terminal-evidence-conflict" };
  }
  if (record.state === "planned") {
    return { action: "blocked", reason: "planned-without-stage" };
  }
  if (record.state === "compensating" && localCommit === "exact-target") {
    return {
      action: "blocked",
      reason: "compensation-conflicts-with-local-commit"
    };
  }
  if (record.state === "staged" && localCommit === "exact-target") {
    return { action: "roll-forward", reason: "exact-local-commit" };
  }
  if (
    localCommit === "before-target"
    && (
      (record.intent.trashPolicy === "required" && evidence.trash === "recoverable")
      || (
        record.intent.trashPolicy === "not-required"
        && evidence.trash === "not-required"
      )
    )
  ) {
    return { action: "compensate", reason: "local-commit-absent" };
  }
  return { action: "blocked", reason: "trash-evidence-unavailable" };
}

/**
 * Deliberately restricted to temp fixtures. Production participant recovery is
 * not wired in this slice.
 */
export async function recoverFixtureRecordMutation(input: {
  journal: LoadedRecordMutationJournal;
  evidence: RecordMutationRecoveryEvidence;
  compensation?: {
    participantId: string;
    receipt: RecordMutationTrashReceipt;
    sourceRootPath: string;
    sourceRootBinding: RecordRootBindingRef;
    trashRootPath: string;
    trashRootBinding: RecordRootBindingRef;
  };
  now: number;
  fixtureOnly: true;
}): Promise<{
  decision: RecordMutationRecoveryDecision;
  journal: LoadedRecordMutationJournal;
}> {
  if (input.fixtureOnly !== true) {
    throw new RecordMutationRecoveryError(
      "fixture_only",
      "record mutation recovery runner 只允许 fixture"
    );
  }
  await assertTemporaryFixturePath(input.journal.handle.storageRootPath);
  if (input.compensation) {
    await assertTemporaryFixturePath(input.compensation.sourceRootPath);
    await assertTemporaryFixturePath(input.compensation.trashRootPath);
  }
  const current = await loadRecordMutationJournal(input.journal.handle);
  const evidence = parseRecordMutationRecoveryEvidence(input.evidence);
  const decision = decideRecordMutationRecovery(current.record, evidence);
  if (decision.action === "none" || decision.action === "blocked") {
    return { decision, journal: current };
  }
  const firstTimestamp = Math.max(input.now, current.record.updatedAt + 1);
  if (decision.action === "roll-forward") {
    const committed = await commitRecordMutationJournal(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      committedAt: firstTimestamp,
      message: "fixture recovery verified exact local commit"
    });
    return { decision, journal: committed };
  }

  const validatedCompensation = input.compensation
    ? {
        ...input.compensation,
        receipt: parseRecordMutationTrashReceipt(input.compensation.receipt)
      }
    : null;
  if (
    validatedCompensation
    && validatedCompensation.receipt.mutationId !== current.record.mutationId
  ) {
    throw new RecordMutationRecoveryError(
      "recovery_blocked",
      "fixture compensation receipt mutationId 不匹配"
    );
  }
  if (
    validatedCompensation
    && (
      !containsRootBinding(
        current.record.intent.rootBindings,
        validatedCompensation.receipt.sourceRootBinding
      )
      || !containsRootBinding(
        current.record.intent.rootBindings,
        validatedCompensation.receipt.trashRootBinding
      )
    )
  ) {
    throw new RecordMutationRecoveryError(
      "recovery_blocked",
      "fixture compensation receipt Root Binding 不在 intent 中"
    );
  }
  const participantId = validatedCompensation?.participantId
    ?? current.record.step?.participantId
    ?? current.record.intent.participants[0]?.id;
  if (!participantId) {
    throw new RecordMutationRecoveryError(
      "recovery_blocked",
      "fixture compensation 缺少 participant"
    );
  }
  if (
    !current.record.intent.participants.some(
      (participant) => participant.id === participantId
    )
  ) {
    throw new RecordMutationRecoveryError(
      "recovery_blocked",
      "fixture compensation participant 不在 intent 中"
    );
  }

  const forwardActions = new Set(current.chain.flatMap((revision) => (
    revision.step?.direction === "forward"
      && revision.step.participantId === participantId
      ? [revision.step.action]
      : []
  )));
  let compensating = current;
  let timestamp = firstTimestamp;
  const existingCompensationActions = new Set(current.chain.flatMap((revision) => (
    revision.step?.direction === "compensating"
      && revision.step.participantId === participantId
      ? [revision.step.action]
      : []
  )));
  if (!existingCompensationActions.has("compensation-prepared")) {
    compensating = await beginRecordMutationCompensation(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      step: {
        direction: "compensating",
        ordinal: nextCompensationOrdinal(current),
        participantId,
        action: "compensation-prepared",
        evidenceDigest: validatedCompensation?.receipt.digest ?? current.record.digest
      },
      updatedAt: timestamp
    });
    timestamp = compensating.record.updatedAt + 1;
  }

  if (
    forwardActions.has("source-retired")
    && !existingCompensationActions.has("trash-restored")
  ) {
    if (!validatedCompensation) {
      throw new RecordMutationRecoveryError(
        "recovery_blocked",
        "retired source 缺少 fixture compensation receipt"
      );
    }
    const receipt = validatedCompensation.receipt;
    await restoreRecordMutationTrash({
      receipt,
      sourceRootPath: validatedCompensation.sourceRootPath,
      sourceRootBinding: validatedCompensation.sourceRootBinding,
      trashRootPath: validatedCompensation.trashRootPath,
      trashRootBinding: validatedCompensation.trashRootBinding
    });
    compensating = await beginRecordMutationCompensation(compensating.handle, {
      expectedRevision: compensating.record.revision,
      expectedDigest: compensating.record.digest,
      step: {
        direction: "compensating",
        ordinal: nextCompensationOrdinal(compensating),
        participantId,
        action: "trash-restored",
        evidenceDigest: receipt.digest
      },
      updatedAt: timestamp
    });
    timestamp = compensating.record.updatedAt + 1;
  } else if (!validatedCompensation && evidence.trash !== "not-required") {
    throw new RecordMutationRecoveryError(
      "recovery_blocked",
      "recoverable trash 缺少 fixture compensation receipt"
    );
  }

  const abortedAt = Math.max(timestamp, compensating.record.updatedAt + 1);
  const aborted = await finalizeRecordMutationAbort(compensating.handle, {
    expectedRevision: compensating.record.revision,
    expectedDigest: compensating.record.digest,
    abortedAt,
    code: "compensated",
    message: "fixture recovery restored staged records"
  });
  return { decision, journal: aborted };
}

function nextCompensationOrdinal(
  journal: LoadedRecordMutationJournal
): number {
  const ordinals = journal.chain.flatMap((revision) => (
    revision.step?.direction === "compensating"
      ? [revision.step.ordinal]
      : []
  ));
  return (ordinals.length ? Math.max(...ordinals) : 0) + 1;
}

async function assertTemporaryFixturePath(absolutePath: string): Promise<void> {
  const fixturePath = path.resolve(await fsp.realpath(absolutePath));
  const temporaryRoot = path.resolve(await fsp.realpath(tmpdir()));
  const relative = path.relative(temporaryRoot, fixturePath);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new RecordMutationRecoveryError(
      "fixture_only",
      `fixture recovery path 不在系统临时目录内：${absolutePath}`
    );
  }
}

function sameRootBindingSet(
  left: readonly RecordRootBindingRef[],
  right: readonly RecordRootBindingRef[]
): boolean {
  return left.length === right.length
    && left.every((binding, index) => (
      right[index] !== undefined
      && sameRecordRootBindingRef(binding, right[index])
    ));
}

function containsRootBinding(
  bindings: readonly RecordRootBindingRef[],
  expected: RecordRootBindingRef
): boolean {
  return bindings.some((binding) => (
    sameRecordRootBindingRef(binding, expected)
  ));
}

function requirePlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw evidenceCorrupt("recovery evidence 不是对象");
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw evidenceCorrupt("recovery evidence 不是 plain object");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw evidenceCorrupt("recovery evidence 字段集合非法");
  }
}

function evidenceCorrupt(message: string): RecordMutationRecoveryError {
  return new RecordMutationRecoveryError("evidence_corrupt", message);
}
