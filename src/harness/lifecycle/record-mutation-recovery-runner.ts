import {
  coordinateRecordMutationTrashRestore,
  coordinateRecordMutationTrashRetirement,
  inspectRecordMutationTrashRecovery,
  type RecordMutationCoordinatorRoots
} from "./record-mutation-coordinator";
import {
  parseRecordMutationIntent,
  type RecordMutationIntent,
  type RecordMutationStepAction
} from "./record-mutation-contract";
import {
  beginRecordMutationCompensation,
  commitRecordMutationJournal,
  finalizeRecordMutationAbort,
  loadRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "./record-mutation-journal";
import {
  decideRecordMutationRecovery,
  parseRecordMutationConversationObservation,
  type RecordMutationConversationObservation,
  type RecordMutationRecoveryDecision,
  type RecordMutationRecoveryEvidence
} from "./record-mutation-recovery";
import {
  parseRecordMutationTrashReceipt,
  type RecordMutationTrashReceipt,
  type RecordMutationTrashRestoreJudgment
} from "./record-mutation-trash";
import {
  coordinateRecordMutationSourceParticipantForward,
  coordinateRecordMutationSourceParticipantRestore,
  reconcileRecordMutationSourceParticipantForward,
  validateRecordMutationSourceParticipants,
  verifyRecordMutationSourceParticipantAborted,
  verifyRecordMutationSourceParticipantForward,
  type RecordMutationSourceParticipantAdapter
} from "./record-mutation-source-participant";

export interface RecordMutationRecoveryTrashParticipant
extends RecordMutationCoordinatorRoots {
  participantId: string;
  receipt: RecordMutationTrashReceipt;
}

export interface RunRecordMutationRecoveryInput {
  journal: LoadedRecordMutationJournal;
  withConversationMutation: <T>(
    conversationId: string,
    action: () => Promise<T>
  ) => Promise<T>;
  inspectConversation: (
    intent: RecordMutationIntent
  ) => Promise<RecordMutationConversationObservation>;
  trashParticipants: readonly RecordMutationRecoveryTrashParticipant[];
  sourceDeletedParticipants:
    readonly RecordMutationSourceParticipantAdapter[];
  now?: () => number;
}

export type RecordMutationRecoveryRunnerBlocker =
  | Extract<RecordMutationRecoveryDecision, { action: "blocked" }>["reason"]
  | "participant-adapter-required"
  | "effect-verification-failed"
  | "partial-source-conflict"
  | "conversation-evidence-changed";

export type RecordMutationRecoveryRunnerResult =
  | {
      status: "completed";
      decision: Extract<
        RecordMutationRecoveryDecision,
        { action: "roll-forward" | "compensate" }
      >;
      evidence: RecordMutationRecoveryEvidence;
      journal: LoadedRecordMutationJournal;
    }
  | {
      status: "noop";
      decision: Extract<RecordMutationRecoveryDecision, { action: "none" }>;
      evidence: RecordMutationRecoveryEvidence;
      journal: LoadedRecordMutationJournal;
    }
  | {
      status: "blocked";
      decision: RecordMutationRecoveryDecision;
      blocker: RecordMutationRecoveryRunnerBlocker;
      evidence: RecordMutationRecoveryEvidence;
      journal: LoadedRecordMutationJournal;
    };

export class RecordMutationRecoveryRunnerError extends Error {
  constructor(
    public readonly code:
      | "journal_mismatch"
      | "participant_mismatch",
    message: string
  ) {
    super(message);
    this.name = "RecordMutationRecoveryRunnerError";
  }
}

/**
 * Production recovery entry. The caller must supply the same in-process
 * Conversation mutation authority used by live product writes. The runner
 * holds it across durable readback, effects, repeated verification, and
 * terminal publication. Callers cannot supply a pre-classified `exact-target`
 * claim; destructive effects still route through RecordMutation coordinator.
 */
export async function runRecordMutationRecovery(
  input: RunRecordMutationRecoveryInput
): Promise<RecordMutationRecoveryRunnerResult> {
  const intent = parseRecordMutationIntent(input.journal.record.intent);
  return await input.withConversationMutation(
    intent.conversationId,
    async () => await runRecordMutationRecoveryUnderAuthority(input)
  );
}

async function runRecordMutationRecoveryUnderAuthority(
  input: RunRecordMutationRecoveryInput
): Promise<RecordMutationRecoveryRunnerResult> {
  let current = await loadRecordMutationJournal(input.journal.handle);
  if (current.record.mutationId !== input.journal.record.mutationId) {
    throw new RecordMutationRecoveryRunnerError(
      "journal_mismatch",
      "RecordMutation recovery runner 的 Journal identity 已变化"
    );
  }
  const conversation = await inspectConversationSafely(
    input.inspectConversation,
    current.record.intent
  );
  if (current.record.state === "planned") {
    const evidence = recoveryEvidence(
      current,
      conversation,
      current.record.intent.trashPolicy === "required"
        ? "unknown"
        : "not-required"
    );
    const decision: RecordMutationRecoveryDecision = {
      action: "blocked",
      reason: "planned-without-stage"
    };
    return blocked(current, evidence, decision, decision.reason);
  }

  const trashParticipants = validateTrashParticipants(
    current,
    input.trashParticipants
  );
  const inspection = await inspectTrashParticipants(
    current,
    trashParticipants,
    input.now
  );
  current = inspection.journal;
  const evidence = recoveryEvidence(
    current,
    conversation,
    current.record.intent.trashPolicy === "not-required"
      ? "not-required"
      : inspection.recoverable
        ? "recoverable"
        : "corrupt"
  );
  const decision = decideRecordMutationRecovery(current.record, evidence);
  if (decision.action === "blocked") {
    return blocked(current, evidence, decision, decision.reason);
  }
  if (
    !inspection.recoverable
    && current.record.intent.trashPolicy === "required"
  ) {
    return blocked(
      current,
      evidence,
      decision,
      "trash-evidence-unavailable"
    );
  }
  let sourceDeletedParticipants: RecordMutationSourceParticipantAdapter[];
  try {
    sourceDeletedParticipants = validateRecordMutationSourceParticipants(
      current,
      input.sourceDeletedParticipants
    );
  } catch {
    return blocked(
      current,
      evidence,
      decision,
      "participant-adapter-required"
    );
  }
  if (decision.action === "none") {
    try {
      for (const adapter of sourceDeletedParticipants) {
        current = current.record.state === "committed"
          ? await verifyRecordMutationSourceParticipantForward({
            journal: current,
            adapter
          })
          : await verifyRecordMutationSourceParticipantAborted({
            journal: current,
            adapter
          });
      }
    } catch {
      return blocked(
        current,
        evidence,
        decision,
        "effect-verification-failed"
      );
    }
    return { status: "noop", decision, evidence, journal: current };
  }
  return decision.action === "roll-forward"
    ? await rollForward(
      input,
      current,
      evidence,
      decision,
      trashParticipants,
      sourceDeletedParticipants
    )
    : await compensate(
      input,
      current,
      evidence,
      decision,
      trashParticipants,
      sourceDeletedParticipants
    );
}

async function rollForward(
  input: RunRecordMutationRecoveryInput,
  journal: LoadedRecordMutationJournal,
  evidence: RecordMutationRecoveryEvidence,
  decision: Extract<RecordMutationRecoveryDecision, { action: "roll-forward" }>,
  trashParticipants: readonly RecordMutationRecoveryTrashParticipant[],
  sourceDeletedParticipants:
    readonly RecordMutationSourceParticipantAdapter[]
): Promise<RecordMutationRecoveryRunnerResult> {
  let current = journal;
  const changedBeforeEffects = await blockIfConversationEvidenceChanged(
    input,
    current,
    evidence
  );
  if (changedBeforeEffects) return changedBeforeEffects;
  try {
    for (const adapter of sourceDeletedParticipants) {
      current = await coordinateRecordMutationSourceParticipantForward({
        journal: current,
        adapter,
        now: input.now
      });
    }
    for (const participant of trashParticipants) {
      const retired = await coordinateRecordMutationTrashRetirement({
        journal: current,
        participantId: participant.participantId,
        sourceRelativePath: participant.receipt.locator.sourceRelativePath,
        ...coordinatorRoots(participant),
        now: input.now
      });
      current = retired.journal;
    }
    for (const adapter of sourceDeletedParticipants) {
      current = await verifyRecordMutationSourceParticipantForward({
        journal: current,
        adapter
      });
    }
    const changedBeforeCommit = await blockIfConversationEvidenceChanged(
      input,
      current,
      evidence
    );
    if (changedBeforeCommit) return changedBeforeCommit;
    const committed = await commitRecordMutationJournal(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      committedAt: nextTimestamp(current, input.now),
      message: "production recovery verified exact target commit"
    });
    return {
      status: "completed",
      decision,
      evidence,
      journal: committed
    };
  } catch {
    current = await loadRecordMutationJournal(current.handle);
    return blocked(
      current,
      evidence,
      decision,
      "effect-verification-failed"
    );
  }
}

async function compensate(
  input: RunRecordMutationRecoveryInput,
  journal: LoadedRecordMutationJournal,
  evidence: RecordMutationRecoveryEvidence,
  decision: Extract<RecordMutationRecoveryDecision, { action: "compensate" }>,
  trashParticipants: readonly RecordMutationRecoveryTrashParticipant[],
  sourceDeletedParticipants:
    readonly RecordMutationSourceParticipantAdapter[]
): Promise<RecordMutationRecoveryRunnerResult> {
  let current = journal;
  const changedBeforeEffects = await blockIfConversationEvidenceChanged(
    input,
    current,
    evidence
  );
  if (changedBeforeEffects) return changedBeforeEffects;
  try {
    for (const adapter of sourceDeletedParticipants) {
      current = await reconcileRecordMutationSourceParticipantForward({
        journal: current,
        adapter,
        now: input.now
      });
    }
    // First close any "retired effect durable, source-retired Journal missing"
    // crash window. This must finish before the Journal enters compensating.
    for (const participant of trashParticipants) {
      const inspected = await inspectRecordMutationTrashRecovery({
        journal: current,
        participantId: participant.participantId,
        receipt: participant.receipt,
        ...coordinatorRoots(participant),
        now: input.now
      });
      current = inspected.journal;
      if (
        !hasParticipantStep(
          current,
          participant.participantId,
          "forward",
          "source-retired"
        )
        && inspected.judgment.status === "restore-required"
      ) {
        if (inspected.judgment.reason !== "source-missing-trash-exact") {
          return blocked(
            current,
            evidence,
            decision,
            "partial-source-conflict"
          );
        }
        if (current.record.state === "compensating") {
          return blocked(
            current,
            evidence,
            decision,
            "effect-verification-failed"
          );
        }
        current = (
          await coordinateRecordMutationTrashRetirement({
            journal: current,
            participantId: participant.participantId,
            sourceRelativePath: participant.receipt.locator.sourceRelativePath,
            ...coordinatorRoots(participant),
            now: input.now
          })
        ).journal;
      }
    }

    for (const participant of trashParticipants) {
      if (
        !hasParticipantStep(
          current,
          participant.participantId,
          "forward",
          "source-retired"
        )
      ) {
        continue;
      }
      current = await ensureCompensationPrepared(
        current,
        participant.participantId,
        participant.receipt.digest,
        input.now
      );
      current = (
        await coordinateRecordMutationTrashRestore({
          journal: current,
          participantId: participant.participantId,
          receipt: participant.receipt,
          ...coordinatorRoots(participant),
          now: input.now
        })
      ).journal;
    }

    for (const adapter of sourceDeletedParticipants) {
      const forwardEvidence = participantEvidenceDigest(
        current,
        adapter.participantId,
        "forward",
        "participant-staged"
      );
      if (!forwardEvidence) continue;
      current = await ensureCompensationPrepared(
        current,
        adapter.participantId,
        forwardEvidence,
        input.now
      );
      current = await coordinateRecordMutationSourceParticipantRestore({
        journal: current,
        adapter,
        now: input.now
      });
    }

    if (!hasAnyCompensatingStep(current)) {
      const participantId = current.record.step?.participantId
        ?? current.record.intent.participants[0]?.id;
      if (!participantId) {
        throw new RecordMutationRecoveryRunnerError(
          "participant_mismatch",
          "RecordMutation compensation 缺少 participant"
        );
      }
      current = await ensureCompensationPrepared(
        current,
        participantId,
        current.record.digest,
        input.now
      );
    }
    const changedBeforeAbort = await blockIfConversationEvidenceChanged(
      input,
      current,
      evidence
    );
    if (changedBeforeAbort) return changedBeforeAbort;
    const aborted = await finalizeRecordMutationAbort(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      abortedAt: nextTimestamp(current, input.now),
      code: "compensated",
      message: "production recovery restored pre-target state"
    });
    return {
      status: "completed",
      decision,
      evidence,
      journal: aborted
    };
  } catch (error) {
    if (error instanceof RecordMutationRecoveryRunnerError) throw error;
    current = await loadRecordMutationJournal(current.handle);
    return blocked(
      current,
      evidence,
      decision,
      "effect-verification-failed"
    );
  }
}

async function blockIfConversationEvidenceChanged(
  input: RunRecordMutationRecoveryInput,
  journal: LoadedRecordMutationJournal,
  evidence: RecordMutationRecoveryEvidence
): Promise<
  Extract<RecordMutationRecoveryRunnerResult, { status: "blocked" }> | null
> {
  const conversation = await inspectConversationSafely(
    input.inspectConversation,
    journal.record.intent
  );
  if (sameConversationObservation(evidence.conversation, conversation)) {
    return null;
  }
  const refreshedEvidence = recoveryEvidence(
    journal,
    conversation,
    evidence.trash
  );
  return blocked(
    journal,
    refreshedEvidence,
    decideRecordMutationRecovery(journal.record, refreshedEvidence),
    "conversation-evidence-changed"
  );
}

function sameConversationObservation(
  left: RecordMutationConversationObservation,
  right: RecordMutationConversationObservation
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "present" && right.status === "present") {
    return left.generation === right.generation
      && left.commitId === right.commitId
      && left.contentRevision === right.contentRevision;
  }
  if (left.status === "deleted" && right.status === "deleted") {
    return left.tombstoneId === right.tombstoneId
      && left.digest === right.digest;
  }
  return left.status === "missing" || left.status === "unknown";
}

async function inspectConversationSafely(
  inspect: RunRecordMutationRecoveryInput["inspectConversation"],
  intent: RecordMutationIntent
): Promise<RecordMutationConversationObservation> {
  try {
    return parseRecordMutationConversationObservation(
      await inspect(parseRecordMutationIntent(intent))
    );
  } catch {
    return { status: "unknown" };
  }
}

function validateTrashParticipants(
  journal: LoadedRecordMutationJournal,
  participantsInput: readonly RecordMutationRecoveryTrashParticipant[]
): RecordMutationRecoveryTrashParticipant[] {
  if (!isRuntimeArray(participantsInput)) {
    throw new RecordMutationRecoveryRunnerError(
      "participant_mismatch",
      "trashParticipants 不是数组"
    );
  }
  const expected = journal.record.intent.participants
    .filter((participant) => (
      participant.action === "stage" || participant.action === "discard"
    ))
    .map((participant) => participant.id);
  const participants = participantsInput.map((participant) => ({
    ...participant,
    receipt: parseRecordMutationTrashReceipt(participant.receipt)
  }));
  const actual = participants.map((participant) => participant.participantId);
  if (
    actual.length !== expected.length
    || actual.some((participantId, index) => participantId !== expected[index])
    || new Set(actual).size !== actual.length
  ) {
    throw new RecordMutationRecoveryRunnerError(
      "participant_mismatch",
      "trashParticipants 必须与 intent 中的 destructive participants 完整同序"
    );
  }
  return participants;
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

async function inspectTrashParticipants(
  journal: LoadedRecordMutationJournal,
  participants: readonly RecordMutationRecoveryTrashParticipant[],
  now: (() => number) | undefined
): Promise<{
  journal: LoadedRecordMutationJournal;
  recoverable: boolean;
  judgments: ReadonlyMap<string, RecordMutationTrashRestoreJudgment>;
}> {
  if (journal.record.intent.trashPolicy === "not-required") {
    return {
      journal,
      recoverable: true,
      judgments: new Map()
    };
  }
  let current = journal;
  const judgments = new Map<string, RecordMutationTrashRestoreJudgment>();
  try {
    for (const participant of participants) {
      const inspected = await inspectRecordMutationTrashRecovery({
        journal: current,
        participantId: participant.participantId,
        receipt: participant.receipt,
        ...coordinatorRoots(participant),
        now
      });
      current = inspected.journal;
      judgments.set(participant.participantId, inspected.judgment);
      if (inspected.judgment.status === "blocked") {
        return { journal: current, recoverable: false, judgments };
      }
    }
    return { journal: current, recoverable: true, judgments };
  } catch {
    current = await loadRecordMutationJournal(current.handle);
    return { journal: current, recoverable: false, judgments };
  }
}

function recoveryEvidence(
  journal: LoadedRecordMutationJournal,
  conversation: RecordMutationConversationObservation,
  trash: RecordMutationRecoveryEvidence["trash"]
): RecordMutationRecoveryEvidence {
  return {
    schemaVersion: 2,
    kind: "record-mutation-recovery-evidence",
    mutationId: journal.record.mutationId,
    intentDigest: journal.record.intentDigest,
    rootBindings: journal.record.intent.rootBindings,
    conversation,
    trash
  };
}

async function ensureCompensationPrepared(
  journal: LoadedRecordMutationJournal,
  participantId: string,
  evidenceDigest: string,
  now: (() => number) | undefined
): Promise<LoadedRecordMutationJournal> {
  const existing = participantEvidenceDigest(
    journal,
    participantId,
    "compensating",
    "compensation-prepared"
  );
  if (existing) {
    if (existing !== evidenceDigest) {
      throw new Error(
        `RecordMutation participant ${participantId} compensation evidence changed`
      );
    }
    return journal;
  }
  return await beginRecordMutationCompensation(journal.handle, {
    expectedRevision: journal.record.revision,
    expectedDigest: journal.record.digest,
    step: {
      direction: "compensating",
      ordinal: nextDirectionOrdinal(journal, "compensating"),
      participantId,
      action: "compensation-prepared",
      evidenceDigest
    },
    updatedAt: nextTimestamp(journal, now)
  });
}

function participantEvidenceDigest(
  journal: LoadedRecordMutationJournal,
  participantId: string,
  direction: "forward" | "compensating",
  action: RecordMutationStepAction
): string | null {
  return journal.chain.find((revision) => (
    revision.step?.participantId === participantId
    && revision.step.direction === direction
    && revision.step.action === action
  ))?.step?.evidenceDigest ?? null;
}

function hasParticipantStep(
  journal: LoadedRecordMutationJournal,
  participantId: string,
  direction: "forward" | "compensating",
  action: RecordMutationStepAction
): boolean {
  return journal.chain.some((revision) => (
    revision.step?.participantId === participantId
    && revision.step.direction === direction
    && revision.step.action === action
  ));
}

function hasAnyCompensatingStep(
  journal: LoadedRecordMutationJournal
): boolean {
  return journal.chain.some(
    (revision) => revision.step?.direction === "compensating"
  );
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
    throw new RecordMutationRecoveryRunnerError(
      "journal_mismatch",
      "RecordMutation recovery clock 非法"
    );
  }
  return Math.max(candidate, journal.record.updatedAt + 1);
}

function coordinatorRoots(
  participant: RecordMutationRecoveryTrashParticipant
): RecordMutationCoordinatorRoots {
  return {
    storageRootPath: participant.storageRootPath,
    sourceRootPath: participant.sourceRootPath,
    sourceBoundaryRootPath: participant.sourceBoundaryRootPath,
    sourceRootBinding: participant.sourceRootBinding,
    trashRootPath: participant.trashRootPath,
    trashBoundaryRootPath: participant.trashBoundaryRootPath,
    trashRootBinding: participant.trashRootBinding
  };
}

function blocked(
  journal: LoadedRecordMutationJournal,
  evidence: RecordMutationRecoveryEvidence,
  decision: RecordMutationRecoveryDecision,
  blocker: RecordMutationRecoveryRunnerBlocker
): Extract<RecordMutationRecoveryRunnerResult, { status: "blocked" }> {
  return {
    status: "blocked",
    decision,
    blocker,
    evidence,
    journal
  };
}
