import { createHash } from "node:crypto";

export const RECORD_MUTATION_SCHEMA_VERSION = 1;
export const RECORD_MUTATION_MAX_RECORD_BYTES = 1024 * 1024;
export const RECORD_MUTATION_MAX_REVISIONS = 256;
export const RECORD_MUTATION_MAX_PARTICIPANTS = 32;
export const RECORD_MUTATION_MAX_STEPS = 128;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;

export type RecordMutationOperation =
  | "start-new-context"
  | "reset-agent-cache"
  | "clear-conversation-records"
  | "delete-conversation";

export type RecordMutationState =
  | "planned"
  | "staged"
  | "committed"
  | "compensating"
  | "aborted";

export type RecordMutationRecordKind =
  | "conversation"
  | "workflow-run"
  | "raw"
  | "memory"
  | "artifact";

export type RecordMutationParticipantAction =
  | "retain"
  | "stage"
  | "mark-source-deleted"
  | "discard";

export interface RecordMutationParticipant {
  id: string;
  recordKind: RecordMutationRecordKind;
  action: RecordMutationParticipantAction;
}

export interface RecordMutationIntent {
  operation: RecordMutationOperation;
  conversationId: string;
  expectedConversationGeneration: number;
  expectedConversationCommitId: string | null;
  participants: RecordMutationParticipant[];
  trashPolicy: "not-required" | "required";
}

export type RecordMutationStepAction =
  | "prepared"
  | "trash-staged"
  | "source-retired"
  | "participant-staged"
  | "compensation-prepared"
  | "trash-restored"
  | "participant-restored";

export interface RecordMutationStep {
  direction: "forward" | "compensating";
  ordinal: number;
  participantId: string;
  action: RecordMutationStepAction;
  evidenceDigest: string;
}

export interface RecordMutationTerminal {
  at: number;
  code: "committed" | "compensated" | "recovery-aborted";
  message: string;
}

export interface RecordMutationRevision {
  schemaVersion: typeof RECORD_MUTATION_SCHEMA_VERSION;
  kind: "record-mutation";
  mutationId: string;
  intent: RecordMutationIntent;
  intentDigest: string;
  state: RecordMutationState;
  step: RecordMutationStep | null;
  terminal: RecordMutationTerminal | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
  previousRevision: number | null;
  previousDigest: string | null;
  digest: string;
}

export type RecordMutationContractErrorCode =
  | "invalid_schema"
  | "unknown_field"
  | "invalid_value"
  | "invalid_transition"
  | "digest_mismatch";

export class RecordMutationContractError extends Error {
  constructor(
    public readonly code: RecordMutationContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RecordMutationContractError";
  }
}

export function createPlannedRecordMutationRevision(input: {
  mutationId: string;
  intent: RecordMutationIntent;
  createdAt: number;
}): RecordMutationRevision {
  const intent = parseRecordMutationIntent(input.intent);
  const createdAt = requireSafeInteger(input.createdAt, "createdAt", 0);
  const draft: Omit<RecordMutationRevision, "digest"> = {
    schemaVersion: RECORD_MUTATION_SCHEMA_VERSION,
    kind: "record-mutation",
    mutationId: requireSafeId(input.mutationId, "mutationId"),
    intent,
    intentDigest: recordMutationDigest(intent),
    state: "planned",
    step: null,
    terminal: null,
    createdAt,
    updatedAt: createdAt,
    revision: 0,
    previousRevision: null,
    previousDigest: null
  };
  return parseRecordMutationRevision({
    ...draft,
    digest: recordMutationDigest(draft)
  });
}

export function transitionRecordMutationRevision(
  previousInput: RecordMutationRevision,
  input: {
    state: Exclude<RecordMutationState, "planned">;
    step: RecordMutationStep | null;
    terminal: RecordMutationTerminal | null;
    updatedAt: number;
  }
): RecordMutationRevision {
  const previous = parseRecordMutationRevision(previousInput);
  const draft: Omit<RecordMutationRevision, "digest"> = {
    schemaVersion: previous.schemaVersion,
    kind: previous.kind,
    mutationId: previous.mutationId,
    intent: cloneJson(previous.intent),
    intentDigest: previous.intentDigest,
    state: input.state,
    step: input.step === null ? null : parseRecordMutationStep(input.step),
    terminal: input.terminal === null
      ? null
      : parseRecordMutationTerminal(input.terminal),
    createdAt: previous.createdAt,
    updatedAt: requireSafeInteger(input.updatedAt, "updatedAt", 0),
    revision: previous.revision + 1,
    previousRevision: previous.revision,
    previousDigest: previous.digest
  };
  const next = parseRecordMutationRevision({
    ...draft,
    digest: recordMutationDigest(draft)
  });
  assertRecordMutationTransition(previous, next);
  return next;
}

export function parseRecordMutationRevision(
  value: unknown
): RecordMutationRevision {
  const record = requirePlainRecord(value, "record mutation revision");
  assertRecordSize(record);
  assertExactKeys(record, [
    "schemaVersion",
    "kind",
    "mutationId",
    "intent",
    "intentDigest",
    "state",
    "step",
    "terminal",
    "createdAt",
    "updatedAt",
    "revision",
    "previousRevision",
    "previousDigest",
    "digest"
  ], "record mutation revision");
  if (record.schemaVersion !== RECORD_MUTATION_SCHEMA_VERSION) {
    throw new RecordMutationContractError(
      "invalid_schema",
      `record mutation schema 不受支持：${String(record.schemaVersion)}`
    );
  }
  if (record.kind !== "record-mutation") {
    throw invalidValue("record mutation kind 非法");
  }
  const mutationId = requireSafeId(record.mutationId, "mutationId");
  const intent = parseRecordMutationIntent(record.intent);
  const intentDigest = requireDigest(record.intentDigest, "intentDigest");
  if (intentDigest !== recordMutationDigest(intent)) {
    throw new RecordMutationContractError(
      "digest_mismatch",
      "intentDigest 与 intent 不匹配"
    );
  }
  const state = parseState(record.state);
  const step = record.step === null ? null : parseRecordMutationStep(record.step);
  const terminal = record.terminal === null
    ? null
    : parseRecordMutationTerminal(record.terminal);
  const createdAt = requireSafeInteger(record.createdAt, "createdAt", 0);
  const updatedAt = requireSafeInteger(record.updatedAt, "updatedAt", createdAt);
  const revision = requireSafeInteger(
    record.revision,
    "revision",
    0,
    RECORD_MUTATION_MAX_REVISIONS - 1
  );
  const previousRevision = record.previousRevision === null
    ? null
    : requireSafeInteger(
      record.previousRevision,
      "previousRevision",
      0,
      RECORD_MUTATION_MAX_REVISIONS - 1
    );
  const previousDigest = record.previousDigest === null
    ? null
    : requireDigest(record.previousDigest, "previousDigest");
  const digest = requireDigest(record.digest, "digest");

  if (revision === 0) {
    if (
      previousRevision !== null
      || previousDigest !== null
      || state !== "planned"
      || step !== null
      || terminal !== null
      || updatedAt !== createdAt
    ) {
      throw invalidValue("revision 0 必须是无前序的 planned record");
    }
  } else if (
    previousRevision !== revision - 1
    || previousDigest === null
    || state === "planned"
  ) {
    throw invalidValue("record mutation revision 前序字段非法");
  }
  assertStatePayload(state, step, terminal);
  if (terminal && terminal.at !== updatedAt) {
    throw invalidValue("terminal.at 必须等于 revision.updatedAt");
  }

  const parsed: RecordMutationRevision = {
    schemaVersion: RECORD_MUTATION_SCHEMA_VERSION,
    kind: "record-mutation",
    mutationId,
    intent,
    intentDigest,
    state,
    step,
    terminal,
    createdAt,
    updatedAt,
    revision,
    previousRevision,
    previousDigest,
    digest
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (digest !== recordMutationDigest(withoutDigest)) {
    throw new RecordMutationContractError(
      "digest_mismatch",
      "record mutation digest 不匹配"
    );
  }
  return parsed;
}

export function parseRecordMutationIntent(
  value: unknown
): RecordMutationIntent {
  const record = requirePlainRecord(value, "record mutation intent");
  assertExactKeys(record, [
    "operation",
    "conversationId",
    "expectedConversationGeneration",
    "expectedConversationCommitId",
    "participants",
    "trashPolicy"
  ], "record mutation intent");
  const operation = parseOperation(record.operation);
  const conversationId = requireSafeId(record.conversationId, "conversationId");
  const expectedConversationGeneration = requireSafeInteger(
    record.expectedConversationGeneration,
    "expectedConversationGeneration",
    0
  );
  const expectedConversationCommitId = record.expectedConversationCommitId === null
    ? null
    : requireSafeId(
      record.expectedConversationCommitId,
      "expectedConversationCommitId"
    );
  if (
    !Array.isArray(record.participants)
    || record.participants.length < 1
    || record.participants.length > RECORD_MUTATION_MAX_PARTICIPANTS
  ) {
    throw invalidValue("participants 数量非法");
  }
  const participants = record.participants.map((participant, index) => (
    parseParticipant(participant, index)
  ));
  const participantIds = participants.map((participant) => participant.id);
  if (new Set(participantIds).size !== participantIds.length) {
    throw invalidValue("participants id 必须唯一");
  }
  const sortedIds = [...participantIds].sort(compareText);
  if (participantIds.some((id, index) => id !== sortedIds[index])) {
    throw invalidValue("participants 必须按 id 排序以保持确定性");
  }
  if (record.trashPolicy !== "not-required" && record.trashPolicy !== "required") {
    throw invalidValue("trashPolicy 非法");
  }
  const destructive = operation === "clear-conversation-records"
    || operation === "delete-conversation";
  if (destructive !== (record.trashPolicy === "required")) {
    throw invalidValue("operation 与 trashPolicy 不匹配");
  }
  if (
    destructive
      ? !participants.some((participant) => participant.action === "stage")
      : participants.some((participant) => participant.action !== "retain")
  ) {
    throw invalidValue("operation 与 participant action 不匹配");
  }
  return {
    operation,
    conversationId,
    expectedConversationGeneration,
    expectedConversationCommitId,
    participants,
    trashPolicy: record.trashPolicy
  };
}

export function parseRecordMutationStep(
  value: unknown
): RecordMutationStep {
  const record = requirePlainRecord(value, "record mutation step");
  assertExactKeys(record, [
    "direction",
    "ordinal",
    "participantId",
    "action",
    "evidenceDigest"
  ], "record mutation step");
  if (record.direction !== "forward" && record.direction !== "compensating") {
    throw invalidValue("step.direction 非法");
  }
  const ordinal = requireSafeInteger(
    record.ordinal,
    "step.ordinal",
    1,
    RECORD_MUTATION_MAX_STEPS
  );
  const participantId = requireSafeId(record.participantId, "step.participantId");
  const action = parseStepAction(record.action);
  const forwardAction = action === "prepared"
    || action === "trash-staged"
    || action === "source-retired"
    || action === "participant-staged";
  if ((record.direction === "forward") !== forwardAction) {
    throw invalidValue("step direction 与 action 不匹配");
  }
  return {
    direction: record.direction,
    ordinal,
    participantId,
    action,
    evidenceDigest: requireDigest(record.evidenceDigest, "step.evidenceDigest")
  };
}

export function parseRecordMutationTerminal(
  value: unknown
): RecordMutationTerminal {
  const record = requirePlainRecord(value, "record mutation terminal");
  assertExactKeys(record, ["at", "code", "message"], "record mutation terminal");
  if (
    record.code !== "committed"
    && record.code !== "compensated"
    && record.code !== "recovery-aborted"
  ) {
    throw invalidValue("terminal.code 非法");
  }
  return {
    at: requireSafeInteger(record.at, "terminal.at", 0),
    code: record.code,
    message: requireSafeText(record.message, "terminal.message", 2_000, false)
  };
}

export function assertRecordMutationTransition(
  previousInput: RecordMutationRevision,
  currentInput: RecordMutationRevision
): void {
  const previous = parseRecordMutationRevision(previousInput);
  const current = parseRecordMutationRevision(currentInput);
  if (
    current.schemaVersion !== previous.schemaVersion
    || current.kind !== previous.kind
    || current.mutationId !== previous.mutationId
    || stableRecordMutationStringify(current.intent)
      !== stableRecordMutationStringify(previous.intent)
    || current.intentDigest !== previous.intentDigest
    || current.createdAt !== previous.createdAt
    || current.revision !== previous.revision + 1
    || current.previousRevision !== previous.revision
    || current.previousDigest !== previous.digest
    || current.updatedAt <= previous.updatedAt
  ) {
    throw new RecordMutationContractError(
      "invalid_transition",
      "record mutation immutable fields、revision 或 digest chain 不匹配"
    );
  }
  if (
    current.step
    && !current.intent.participants.some(
      (participant) => participant.id === current.step?.participantId
    )
  ) {
    throw new RecordMutationContractError(
      "invalid_transition",
      "step 引用了 intent 中不存在的 participant"
    );
  }

  if (previous.state === "planned") {
    requireTransition(current.state === "staged", "planned 只能进入 staged");
    requireTransition(
      current.step?.direction === "forward" && current.step.ordinal === 1,
      "首个 staged step 必须是 forward ordinal 1"
    );
    return;
  }
  if (previous.state === "staged") {
    if (current.state === "staged") {
      requireTransition(
        previous.step?.direction === "forward"
          && current.step?.direction === "forward"
          && current.step.ordinal === previous.step.ordinal + 1,
        "staged step 必须连续递增"
      );
      return;
    }
    if (current.state === "committed") return;
    if (current.state === "compensating") {
      requireTransition(
        current.step?.direction === "compensating"
          && current.step.ordinal === 1,
        "首个 compensating step 必须是 ordinal 1"
      );
      return;
    }
    throw invalidTransition("staged 只能继续 staged、committed 或 compensating");
  }
  if (previous.state === "compensating") {
    if (current.state === "compensating") {
      requireTransition(
        previous.step?.direction === "compensating"
          && current.step?.direction === "compensating"
          && current.step.ordinal === previous.step.ordinal + 1,
        "compensating step 必须连续递增"
      );
      return;
    }
    requireTransition(current.state === "aborted", "compensating 只能进入 aborted");
    return;
  }
  throw invalidTransition(`${previous.state} 是终态，禁止继续追加`);
}

/**
 * Validate invariants that require the complete immutable revision chain.
 *
 * A single transition cannot prove that every participant reached its durable
 * forward state, or that every destructive side effect was compensated before
 * abort. Journal writers must call this before publishing a terminal revision,
 * and readers must call it after loading the complete chain.
 */
export function assertRecordMutationChainCompleteness(
  chainInput: readonly RecordMutationRevision[]
): void {
  if (!Array.isArray(chainInput) || chainInput.length < 1) {
    throw invalidTransition("record mutation chain 不能为空");
  }
  const chain = chainInput.map((revision) => parseRecordMutationRevision(revision));
  for (let index = 1; index < chain.length; index += 1) {
    assertRecordMutationTransition(chain[index - 1], chain[index]);
  }

  const current = chain[chain.length - 1];
  const participants = new Map(
    current.intent.participants.map((participant) => [participant.id, participant])
  );
  const forwardActions = new Map<string, Set<RecordMutationStepAction>>();
  const compensatingActions = new Map<string, Set<RecordMutationStepAction>>();

  for (const revision of chain) {
    const step = revision.step;
    if (!step) continue;
    const participant = participants.get(step.participantId);
    if (!participant) {
      throw invalidTransition(
        `step 引用了不存在的 participant：${step.participantId}`
      );
    }
    const actions = step.direction === "forward"
      ? forwardActions
      : compensatingActions;
    const participantActions = actions.get(step.participantId) ?? new Set();
    if (participantActions.has(step.action)) {
      throw invalidTransition(
        `participant ${step.participantId} 重复记录 ${step.action}`
      );
    }
    participantActions.add(step.action);
    actions.set(step.participantId, participantActions);

    if (step.direction === "forward") {
      assertForwardStepMatchesParticipant(
        current.intent,
        participant,
        step.action,
        participantActions
      );
    } else {
      assertCompensatingStepMatchesParticipant(
        participant,
        step.action,
        forwardActions.get(step.participantId) ?? new Set(),
        participantActions
      );
    }
  }

  if (current.state === "committed") {
    for (const participant of current.intent.participants) {
      const actions = forwardActions.get(participant.id) ?? new Set();
      if (participant.action === "stage" || participant.action === "discard") {
        requireTransition(
          actions.has("trash-staged") && actions.has("source-retired"),
          `participant ${participant.id} 缺少 trash-staged/source-retired`
        );
      } else if (participant.action === "mark-source-deleted") {
        requireTransition(
          actions.has("participant-staged"),
          `participant ${participant.id} 缺少 participant-staged`
        );
      }
    }
  }

  if (current.state === "aborted") {
    for (const participant of current.intent.participants) {
      const forward = forwardActions.get(participant.id) ?? new Set();
      const compensation = compensatingActions.get(participant.id) ?? new Set();
      if (
        (participant.action === "stage" || participant.action === "discard")
        && forward.has("source-retired")
      ) {
        requireTransition(
          compensation.has("trash-restored"),
          `participant ${participant.id} 的 retired source 尚未恢复`
        );
      }
      if (
        participant.action === "mark-source-deleted"
        && forward.has("participant-staged")
      ) {
        requireTransition(
          compensation.has("participant-restored"),
          `participant ${participant.id} 的 staged mutation 尚未恢复`
        );
      }
    }
  }
}

export function recordMutationDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(stableRecordMutationStringify(value), "utf8"))
    .digest("hex")}`;
}

export function stableRecordMutationStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableRecordMutationStringify).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => (
        `${JSON.stringify(key)}:${stableRecordMutationStringify(value[key])}`
      ))
      .join(",")}}`;
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  throw invalidValue("record mutation 含不可序列化值");
}

function parseParticipant(
  value: unknown,
  index: number
): RecordMutationParticipant {
  const record = requirePlainRecord(value, `participants[${index}]`);
  assertExactKeys(
    record,
    ["id", "recordKind", "action"],
    `participants[${index}]`
  );
  if (
    record.recordKind !== "conversation"
    && record.recordKind !== "workflow-run"
    && record.recordKind !== "raw"
    && record.recordKind !== "memory"
    && record.recordKind !== "artifact"
  ) {
    throw invalidValue(`participants[${index}].recordKind 非法`);
  }
  if (
    record.action !== "retain"
    && record.action !== "stage"
    && record.action !== "mark-source-deleted"
    && record.action !== "discard"
  ) {
    throw invalidValue(`participants[${index}].action 非法`);
  }
  return {
    id: requireSafeId(record.id, `participants[${index}].id`),
    recordKind: record.recordKind,
    action: record.action
  };
}

function parseOperation(value: unknown): RecordMutationOperation {
  if (
    value !== "start-new-context"
    && value !== "reset-agent-cache"
    && value !== "clear-conversation-records"
    && value !== "delete-conversation"
  ) {
    throw invalidValue("record mutation operation 非法");
  }
  return value;
}

function parseState(value: unknown): RecordMutationState {
  if (
    value !== "planned"
    && value !== "staged"
    && value !== "committed"
    && value !== "compensating"
    && value !== "aborted"
  ) {
    throw invalidValue("record mutation state 非法");
  }
  return value;
}

function parseStepAction(value: unknown): RecordMutationStepAction {
  if (
    value !== "prepared"
    && value !== "trash-staged"
    && value !== "source-retired"
    && value !== "participant-staged"
    && value !== "compensation-prepared"
    && value !== "trash-restored"
    && value !== "participant-restored"
  ) {
    throw invalidValue("record mutation step action 非法");
  }
  return value;
}

function assertForwardStepMatchesParticipant(
  intent: RecordMutationIntent,
  participant: RecordMutationParticipant,
  action: RecordMutationStepAction,
  participantActions: ReadonlySet<RecordMutationStepAction>
): void {
  if (action === "prepared") return;
  if (action === "trash-staged") {
    requireTransition(
      intent.trashPolicy === "required"
        && (participant.action === "stage" || participant.action === "discard"),
      `participant ${participant.id} 不允许 trash-staged`
    );
    return;
  }
  if (action === "source-retired") {
    requireTransition(
      intent.trashPolicy === "required"
        && (participant.action === "stage" || participant.action === "discard")
        && participantActions.has("trash-staged"),
      `participant ${participant.id} 必须先 durable trash-staged 才能 source-retired`
    );
    return;
  }
  requireTransition(
    action === "participant-staged"
      && participant.action === "mark-source-deleted",
    `participant ${participant.id} 不允许 ${action}`
  );
}

function assertCompensatingStepMatchesParticipant(
  participant: RecordMutationParticipant,
  action: RecordMutationStepAction,
  forwardActions: ReadonlySet<RecordMutationStepAction>,
  participantActions: ReadonlySet<RecordMutationStepAction>
): void {
  if (action === "compensation-prepared") return;
  requireTransition(
    participantActions.has("compensation-prepared"),
    `participant ${participant.id} 必须先记录 compensation-prepared`
  );
  if (action === "trash-restored") {
    requireTransition(
      (participant.action === "stage" || participant.action === "discard")
        && forwardActions.has("source-retired"),
      `participant ${participant.id} 没有可恢复的 retired trash`
    );
    return;
  }
  requireTransition(
    action === "participant-restored"
      && participant.action === "mark-source-deleted"
      && forwardActions.has("participant-staged"),
    `participant ${participant.id} 没有可恢复的 participant mutation`
  );
}

function assertStatePayload(
  state: RecordMutationState,
  step: RecordMutationStep | null,
  terminal: RecordMutationTerminal | null
): void {
  if (state === "planned") {
    if (step !== null || terminal !== null) {
      throw invalidValue("planned state 不允许 step/terminal");
    }
    return;
  }
  if (state === "staged") {
    if (step?.direction !== "forward" || terminal !== null) {
      throw invalidValue("staged state 必须包含 forward step");
    }
    return;
  }
  if (state === "compensating") {
    if (step?.direction !== "compensating" || terminal !== null) {
      throw invalidValue("compensating state 必须包含 compensating step");
    }
    return;
  }
  if (step !== null || terminal === null) {
    throw invalidValue(`${state} state 必须只包含 terminal`);
  }
  if (terminal.at < 0) {
    throw invalidValue(`${state} terminal timestamp 非法`);
  }
  if (
    (state === "committed" && terminal.code !== "committed")
    || (state === "aborted" && terminal.code === "committed")
  ) {
    throw invalidValue(`${state} 与 terminal.code 不匹配`);
  }
}

function assertRecordSize(value: Record<string, unknown>): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw invalidValue("record mutation 无法序列化");
  }
  if (bytes > RECORD_MUTATION_MAX_RECORD_BYTES) {
    throw invalidValue("record mutation 超过大小上限");
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new RecordMutationContractError(
      "unknown_field",
      `${label} 字段集合非法`
    );
  }
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalidValue(`${label} 不是 plain object`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireSafeId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_ID_PATTERN.test(value)
    || value !== value.trim()
    || value !== value.normalize("NFC")
    || value.includes("/")
    || value.includes("\\")
  ) {
    throw invalidValue(`${label} 非法`);
  }
  return value;
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
    || hasUnsafeControlCharacter(value)
    || value !== value.normalize("NFC")
    || (nonEmpty && (!value.trim() || value !== value.trim()))
  ) {
    throw invalidValue(`${label} 非法`);
  }
  return value;
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw invalidValue(`${label} 非法`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidValue(`${label} 非法`);
  }
  return value;
}

function requireTransition(condition: boolean, message: string): void {
  if (!condition) throw invalidTransition(message);
}

function invalidValue(message: string): RecordMutationContractError {
  return new RecordMutationContractError("invalid_value", message);
}

function invalidTransition(message: string): RecordMutationContractError {
  return new RecordMutationContractError("invalid_transition", message);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
