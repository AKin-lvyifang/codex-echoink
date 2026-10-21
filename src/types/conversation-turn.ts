export const ECHOINK_ASSISTANT_TURN_VIEW_VERSION = 1 as const;
export const ECHOINK_TURN_INTERACTION_RECORD_ENTRY_TYPE =
  "echoink.turn-interaction-record.v1" as const;
export const ECHOINK_TURN_INTERACTION_RECORD_SCHEMA_VERSION = 1 as const;

export type EchoInkAssistantTurnStatus =
  | "preparing"
  | "running"
  | "waiting_for_user"
  | "completing"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type EchoInkTurnProcessNodeKind =
  | "process"
  | "reasoning"
  | "retrieval"
  | "tool"
  | "task"
  | "interaction"
  | "artifact"
  | "diff";

export type EchoInkTurnProcessNodeStatus =
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

/**
 * One chronological item on the shared Assistant Turn process spine.
 *
 * It contains display-safe metadata only. Tool arguments, Tool results,
 * prompts, Provider-private reasoning, and Vault content do not belong here.
 */
export interface EchoInkTurnProcessNode {
  readonly nodeId: string;
  readonly kind: EchoInkTurnProcessNodeKind;
  readonly status: EchoInkTurnProcessNodeStatus;
  readonly title: string;
  readonly summary?: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  /** Existing projected message retained as the content authority. */
  readonly sourceMessageId?: string;
  readonly toolCallId?: string;
  readonly taskPlanId?: string;
  readonly interactionId?: string;
}

export type EchoInkProviderReasoningStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Public Provider reasoning only; never EchoInk process telemetry. */
export interface EchoInkProviderReasoningSnapshot {
  readonly reasoningId: string;
  readonly source: "provider_public";
  readonly status: EchoInkProviderReasoningStatus;
  readonly text: string;
  readonly startedAt: number;
  /** Start of the current public-thinking interval; omitted while inactive. */
  readonly activeSince?: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
}

/**
 * Public reasoning is stored as ordered segments because one ProductRun may
 * alternate between Provider thinking, Tool calls, and answer text multiple
 * times. `providerReasoning` below remains a read-only legacy input only.
 */
export type EchoInkProviderReasoningSegmentSnapshot =
  EchoInkProviderReasoningSnapshot;

export interface EchoInkQuestionOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export interface EchoInkQuestionPrompt {
  readonly questionId: string;
  readonly prompt: string;
  readonly selection: "single" | "multiple";
  readonly options: readonly Readonly<EchoInkQuestionOption>[];
  readonly allowSupplement: boolean;
}

export interface EchoInkQuestionAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly supplement?: string;
}

interface EchoInkInteractionIdentity {
  readonly interactionId: string;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly turnId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EchoInkQuestionInteraction extends EchoInkInteractionIdentity {
  readonly kind: "question";
  readonly status:
    | "pending"
    | "submitting"
    | "answered"
    | "failed"
    | "cancelled"
    | "expired";
  readonly questions: readonly Readonly<EchoInkQuestionPrompt>[];
  readonly answers?: readonly Readonly<EchoInkQuestionAnswer>[];
  /** Zero-based question shown in the one-at-a-time Dock flow. */
  readonly activeQuestionIndex?: number;
  readonly error?: string;
}

export interface EchoInkConfirmationInteraction extends EchoInkInteractionIdentity {
  readonly kind: "confirmation";
  readonly toolCallId: string;
  readonly status:
    | "pending"
    | "submitting"
    | "approved"
    | "denied"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  readonly target?: string;
  readonly preview?: string;
  readonly resultSummary?: string;
  readonly error?: string;
}

export type EchoInkTurnInteraction =
  | EchoInkQuestionInteraction
  | EchoInkConfirmationInteraction;

/** Compact, non-interactive history left on the process spine. */
export interface EchoInkTurnInteractionRecord {
  readonly interactionId: string;
  readonly kind: EchoInkTurnInteraction["kind"];
  readonly outcome:
    | "answered"
    | "approved"
    | "denied"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  readonly summary: string;
  readonly updatedAt: number;
}

export interface EchoInkTurnInteractionRecordEntryData {
  readonly schemaVersion: typeof ECHOINK_TURN_INTERACTION_RECORD_SCHEMA_VERSION;
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly turnId: string;
  readonly record: Readonly<EchoInkTurnInteractionRecord>;
}

export interface EchoInkTurnInteractionSessionEntryView {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface EchoInkAssistantTurnSummary {
  readonly completedSteps: number;
  readonly toolCount: number;
  readonly durationMs: number;
}

/**
 * Display-only snapshot for one bubble-free Assistant Turn.
 *
 * The outer ChatMessage remains the stable virtual-list row and final Markdown
 * authority. References point at existing projected content instead of copying
 * Tool or Artifact payloads into a second persistence model.
 */
export interface EchoInkAssistantTurnSnapshot {
  readonly viewVersion: typeof ECHOINK_ASSISTANT_TURN_VIEW_VERSION;
  readonly conversationId?: string;
  readonly turnId: string;
  readonly status: EchoInkAssistantTurnStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly processNodes: readonly Readonly<EchoInkTurnProcessNode>[];
  readonly providerReasoningSegments?: readonly Readonly<
    EchoInkProviderReasoningSegmentSnapshot
  >[];
  /** Legacy v1 snapshot accepted when reopening older local data. */
  readonly providerReasoning?: Readonly<EchoInkProviderReasoningSnapshot>;
  readonly interactionRecords: readonly Readonly<EchoInkTurnInteractionRecord>[];
  readonly finalAnswerMessageId?: string;
  readonly summary?: Readonly<EchoInkAssistantTurnSummary>;
}

export function isEchoInkAssistantTurnTerminal(
  status: EchoInkAssistantTurnStatus
): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
}

export function cloneEchoInkTurnInteraction(
  interaction: Readonly<EchoInkTurnInteraction>
): Readonly<EchoInkTurnInteraction> {
  if (interaction.kind === "confirmation") {
    return Object.freeze({ ...interaction });
  }
  return Object.freeze({
    ...interaction,
    questions: Object.freeze(interaction.questions.map((question) => Object.freeze({
      ...question,
      options: Object.freeze(question.options.map((option) => Object.freeze({ ...option })))
    }))),
    ...(interaction.answers
      ? {
          answers: Object.freeze(interaction.answers.map((answer) => Object.freeze({
            ...answer,
            selectedOptionIds: Object.freeze([...answer.selectedOptionIds])
          })))
        }
      : {})
  });
}

export function cloneEchoInkAssistantTurn(
  turn: Readonly<EchoInkAssistantTurnSnapshot>
): Readonly<EchoInkAssistantTurnSnapshot> {
  return Object.freeze({
    ...turn,
    processNodes: Object.freeze(turn.processNodes.map((node) => Object.freeze({ ...node }))),
    interactionRecords: Object.freeze(
      turn.interactionRecords.map((record) => Object.freeze({ ...record }))
    ),
    ...(turn.providerReasoningSegments
      ? {
          providerReasoningSegments: Object.freeze(
            turn.providerReasoningSegments.map((segment) =>
              Object.freeze({ ...segment })
            )
          )
        }
      : {}),
    ...(turn.providerReasoning
      ? { providerReasoning: Object.freeze({ ...turn.providerReasoning }) }
      : {}),
    ...(turn.summary ? { summary: Object.freeze({ ...turn.summary }) } : {})
  });
}

export function echoInkProviderReasoningSegments(
  turn: Readonly<EchoInkAssistantTurnSnapshot>
): readonly Readonly<EchoInkProviderReasoningSegmentSnapshot>[] {
  if (turn.providerReasoningSegments?.length) {
    return turn.providerReasoningSegments;
  }
  return turn.providerReasoning
    ? Object.freeze([turn.providerReasoning])
    : Object.freeze([]);
}

export function normalizeEchoInkQuestionPrompts(
  value: unknown
): readonly Readonly<EchoInkQuestionPrompt>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new TypeError("turn_questions_invalid");
  }
  const questionIds = new Set<string>();
  return Object.freeze(value.map((candidate) => {
    const record = strictRecord(candidate, "turn_question_invalid");
    assertExactKeys(record, [
      "questionId",
      "prompt",
      "selection",
      "options"
    ], "turn_question_invalid", ["allowSupplement"]);
    const questionId = interactionIdentity(record.questionId, "questionId");
    if (questionIds.has(questionId)) throw new TypeError("turn_question_duplicate");
    questionIds.add(questionId);
    const prompt = boundedInteractionText(record.prompt, 1_000, "question_prompt");
    if (record.selection !== "single" && record.selection !== "multiple") {
      throw new TypeError("turn_question_selection_invalid");
    }
    if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 8) {
      throw new TypeError("turn_question_options_invalid");
    }
    const optionIds = new Set<string>();
    const options = Object.freeze(record.options.map((rawOption) => {
      const option = strictRecord(rawOption, "turn_question_option_invalid");
      assertExactKeys(
        option,
        ["optionId", "label"],
        "turn_question_option_invalid",
        ["description"]
      );
      const optionId = interactionIdentity(option.optionId, "optionId");
      if (optionIds.has(optionId)) throw new TypeError("turn_question_option_duplicate");
      optionIds.add(optionId);
      const description = optionalInteractionText(option.description, 500, "option_description");
      return Object.freeze({
        optionId,
        label: boundedInteractionText(option.label, 200, "option_label"),
        ...(description ? { description } : {})
      });
    }));
    if (record.allowSupplement !== undefined && typeof record.allowSupplement !== "boolean") {
      throw new TypeError("turn_question_supplement_invalid");
    }
    return Object.freeze({
      questionId,
      prompt,
      selection: record.selection,
      options,
      allowSupplement: record.allowSupplement ?? true
    });
  }));
}

export function normalizeEchoInkQuestionAnswers(
  interaction: Readonly<EchoInkQuestionInteraction>,
  value: unknown
): readonly Readonly<EchoInkQuestionAnswer>[] {
  if (!Array.isArray(value) || value.length !== interaction.questions.length) {
    throw new TypeError("turn_question_answers_invalid");
  }
  const byId = new Map(interaction.questions.map((question) => [question.questionId, question]));
  const seen = new Set<string>();
  const answers = value.map((candidate) => {
    const record = strictRecord(candidate, "turn_question_answer_invalid");
    assertExactKeys(
      record,
      ["questionId", "selectedOptionIds"],
      "turn_question_answer_invalid",
      ["supplement"]
    );
    const questionId = interactionIdentity(record.questionId, "questionId");
    const question = byId.get(questionId);
    if (!question || seen.has(questionId)) throw new TypeError("turn_question_answer_identity_invalid");
    seen.add(questionId);
    if (!Array.isArray(record.selectedOptionIds)) {
      throw new TypeError("turn_question_answer_selection_invalid");
    }
    const selectedOptionIds = record.selectedOptionIds.map((optionId) =>
      interactionIdentity(optionId, "optionId")
    );
    if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
      throw new TypeError("turn_question_answer_selection_invalid");
    }
    const allowed = new Set(question.options.map((option) => option.optionId));
    if (selectedOptionIds.some((optionId) => !allowed.has(optionId))) {
      throw new TypeError("turn_question_answer_selection_invalid");
    }
    if (
      (question.selection === "single" && selectedOptionIds.length > 1)
      || (question.selection === "multiple" && selectedOptionIds.length > question.options.length)
    ) throw new TypeError("turn_question_answer_selection_invalid");
    const supplement = optionalInteractionText(record.supplement, 1_000, "answer_supplement");
    if (supplement && !question.allowSupplement) {
      throw new TypeError("turn_question_answer_supplement_invalid");
    }
    if (!selectedOptionIds.length && !supplement) {
      throw new TypeError("turn_question_answer_empty");
    }
    return Object.freeze({
      questionId,
      selectedOptionIds: Object.freeze(selectedOptionIds),
      ...(supplement ? { supplement } : {})
    });
  });
  return Object.freeze(answers);
}

export function turnInteractionRecordEntryData(input: Readonly<{
  conversationId: string;
  piSessionId: string;
  turnId: string;
  record: Readonly<EchoInkTurnInteractionRecord>;
}>): Readonly<EchoInkTurnInteractionRecordEntryData> {
  return Object.freeze({
    schemaVersion: ECHOINK_TURN_INTERACTION_RECORD_SCHEMA_VERSION,
    conversationId: interactionIdentity(input.conversationId, "conversationId"),
    piSessionId: interactionIdentity(input.piSessionId, "piSessionId"),
    turnId: interactionIdentity(input.turnId, "turnId"),
    record: normalizeInteractionRecord(input.record)
  });
}

export function turnInteractionRecordFromSessionEntry(
  entry: Readonly<EchoInkTurnInteractionSessionEntryView>,
  expectedPiSessionId: string
): Readonly<EchoInkTurnInteractionRecordEntryData> | null {
  if (
    entry.type !== "custom"
    || entry.customType !== ECHOINK_TURN_INTERACTION_RECORD_ENTRY_TYPE
  ) return null;
  const data = strictRecord(entry.data, "turn_interaction_entry_invalid");
  assertExactKeys(data, [
    "schemaVersion",
    "conversationId",
    "piSessionId",
    "turnId",
    "record"
  ], "turn_interaction_entry_invalid");
  if (data.schemaVersion !== ECHOINK_TURN_INTERACTION_RECORD_SCHEMA_VERSION) {
    throw new TypeError("turn_interaction_entry_invalid");
  }
  const normalized = turnInteractionRecordEntryData({
    conversationId: interactionIdentity(data.conversationId, "conversationId"),
    piSessionId: interactionIdentity(data.piSessionId, "piSessionId"),
    turnId: interactionIdentity(data.turnId, "turnId"),
    record: normalizeInteractionRecord(data.record)
  });
  if (normalized.piSessionId !== expectedPiSessionId) {
    throw new TypeError("turn_interaction_entry_identity_mismatch");
  }
  return normalized;
}

function normalizeInteractionRecord(value: unknown): Readonly<EchoInkTurnInteractionRecord> {
  const record = strictRecord(value, "turn_interaction_record_invalid");
  assertExactKeys(record, [
    "interactionId",
    "kind",
    "outcome",
    "summary",
    "updatedAt"
  ], "turn_interaction_record_invalid");
  if (record.kind !== "question" && record.kind !== "confirmation") {
    throw new TypeError("turn_interaction_record_kind_invalid");
  }
  if (![
    "answered",
    "approved",
    "denied",
    "completed",
    "failed",
    "cancelled",
    "expired"
  ].includes(String(record.outcome))) {
    throw new TypeError("turn_interaction_record_outcome_invalid");
  }
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt) || record.updatedAt < 0) {
    throw new TypeError("turn_interaction_record_time_invalid");
  }
  return Object.freeze({
    interactionId: interactionIdentity(record.interactionId, "interactionId"),
    kind: record.kind,
    outcome: record.outcome as EchoInkTurnInteractionRecord["outcome"],
    summary: boundedInteractionText(record.summary, 1_000, "interaction_summary"),
    updatedAt: record.updatedAt
  });
}

function strictRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(code);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  code: string,
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) throw new TypeError(code);
}

function interactionIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value)) {
    throw new TypeError(`turn_interaction_${label}_invalid`);
  }
  return value;
}

function boundedInteractionText(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string") throw new TypeError(`turn_interaction_${label}_invalid`);
  const text = value.trim();
  if (!text || text.length > limit) throw new TypeError(`turn_interaction_${label}_invalid`);
  return text;
}

function optionalInteractionText(value: unknown, limit: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  return boundedInteractionText(value, limit, label);
}
