import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  defineTool,
  type AgentToolResult,
  type SessionManager,
  type ToolCallEvent,
  type ToolDefinition,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  ECHOINK_TURN_INTERACTION_RECORD_ENTRY_TYPE,
  normalizeEchoInkQuestionPrompts,
  turnInteractionRecordEntryData,
  type EchoInkQuestionAnswer,
  type EchoInkQuestionInteraction,
  type EchoInkTurnInteractionRecord
} from "../../types/conversation-turn";
import type { PiTurnInteractionBroker } from "../../plugin/pi-turn-interaction-broker";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";

export const PI_USER_QUESTION_TOOL_ID = "user_question" as const;

export interface PiUserQuestionRunContext {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
}

interface AuthorizedUserQuestionCall {
  readonly questions: readonly Readonly<EchoInkQuestionInteraction["questions"][number]>[];
  state: "authorized" | "consumed" | "result_ready";
  result?: Readonly<{
    interactionId: string;
    outcome: "answered";
    questionCount: number;
    text: string;
  }>;
}

const USER_QUESTION_RESULT_PENDING = "user_question_result_pending_safety";

/**
 * Keeps the structure accepted at tool_call identical to the structure used by
 * execute, and replaces Pi's result with a bounded product-owned envelope.
 */
export class PiUserQuestionToolSecurity
implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_USER_QUESTION_TOOL_ID;

  private readonly calls = new Map<string, AuthorizedUserQuestionCall>();
  private readonly seenToolCallIds = new Set<string>();

  async handleToolCall(
    event: ToolCallEvent,
    _signal: AbortSignal | undefined
  ): Promise<Readonly<{ block: true; reason: string }> | void> {
    if (event.toolName !== this.toolName) return block("tool_policy_blocked");
    if (this.seenToolCallIds.has(event.toolCallId)) {
      return block("authorization_failed");
    }
    this.seenToolCallIds.add(event.toolCallId);
    try {
      const questions = normalizeQuestionArguments(event.input);
      this.calls.set(event.toolCallId, {
        questions,
        state: "authorized"
      });
    } catch {
      return block("tool_policy_blocked");
    }
  }

  consume(
    toolCallId: string,
    rawArguments: unknown
  ): readonly Readonly<EchoInkQuestionInteraction["questions"][number]>[] {
    const call = this.calls.get(toolCallId);
    if (!call || call.state !== "authorized") {
      throw new Error("user_question_authorization_failed");
    }
    const questions = normalizeQuestionArguments(rawArguments);
    if (!isDeepStrictEqual(questions, call.questions)) {
      throw new Error("user_question_authorization_failed");
    }
    call.state = "consumed";
    return call.questions;
  }

  complete(
    toolCallId: string,
    result: Readonly<{
      interactionId: string;
      outcome: "answered";
      questionCount: number;
      text: string;
    }>
  ): void {
    const call = this.calls.get(toolCallId);
    if (!call || call.state !== "consumed") {
      throw new Error("user_question_authorization_failed");
    }
    const text = result.text.trim();
    if (
      !text
      || text.length > 12_000
      || !result.interactionId.trim()
      || result.interactionId.length > 256
      || result.questionCount !== call.questions.length
    ) {
      throw new Error("user_question_result_rejected");
    }
    call.result = Object.freeze({
      interactionId: result.interactionId,
      outcome: result.outcome,
      questionCount: result.questionCount,
      text
    });
    call.state = "result_ready";
  }

  async handleToolResult(event: ToolResultEvent): Promise<Readonly<{
    content: Array<{ type: "text"; text: string }>;
    details: Readonly<Record<string, unknown>>;
    isError: boolean;
  }>> {
    const call = this.calls.get(event.toolCallId);
    try {
      if (
        event.toolName !== this.toolName
        || !call
        || call.state !== "result_ready"
        || !call.result
      ) {
        return rejectedResult(event.toolCallId, "authorization_failed");
      }
      return Object.freeze({
        content: [{ type: "text" as const, text: call.result.text }],
        details: Object.freeze({
          source: "echoink-turn-interaction",
          schemaVersion: 1,
          toolCallId: event.toolCallId,
          interactionId: call.result.interactionId,
          outcome: call.result.outcome,
          questionCount: call.result.questionCount
        }),
        isError: false
      });
    } finally {
      this.calls.delete(event.toolCallId);
    }
  }
}

export function createPiUserQuestionToolDefinition(input: Readonly<{
  sessionManager: SessionManager;
  broker: PiTurnInteractionBroker;
  security: PiUserQuestionToolSecurity;
  currentRun(): Readonly<PiUserQuestionRunContext>;
  reportRequested(interaction: Readonly<EchoInkQuestionInteraction>): Promise<void>;
  reportResolved(record: Readonly<EchoInkTurnInteractionRecord>): Promise<void>;
  now?: () => number;
}>): ToolDefinition {
  const optionSchema = Type.Object({
    optionId: Type.String({ minLength: 1, maxLength: 160 }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
  }, { additionalProperties: false });
  const questionSchema = Type.Object({
    questionId: Type.String({ minLength: 1, maxLength: 160 }),
    prompt: Type.String({ minLength: 1, maxLength: 1_000 }),
    selection: Type.Union([Type.Literal("single"), Type.Literal("multiple")]),
    options: Type.Array(optionSchema, { minItems: 2, maxItems: 8 }),
    allowSupplement: Type.Optional(Type.Boolean({ default: true }))
  }, { additionalProperties: false });

  return defineTool({
    name: PI_USER_QUESTION_TOOL_ID,
    label: "向用户提问",
    description: [
      "当继续执行确实需要用户选择时，发送一到三个结构化问题。",
      "每个问题必须提供二到八个明确选项，并声明单选或多选；默认允许自由补充，可用 allowSupplement=false 关闭。",
      "不要用普通回答文本或问号替代此 Tool，也不要重复询问已经得到的答案。"
    ].join(""),
    parameters: Type.Object({
      questions: Type.Array(questionSchema, { minItems: 1, maxItems: 3 })
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId, rawArguments, signal) => {
      const questions = input.security.consume(_toolCallId, rawArguments);
      const context = normalizeRunContext(input.currentRun());
      const now = input.now?.() ?? Date.now();
      const interactionId = stableInteractionId(
        context.productRunId,
        _toolCallId
      );
      const interaction: Readonly<EchoInkQuestionInteraction> = Object.freeze({
        interactionId,
        conversationId: context.conversationId,
        piSessionId: context.piSessionId,
        turnId: context.productRunId,
        kind: "question",
        status: "pending",
        questions,
        activeQuestionIndex: 0,
        createdAt: now,
        updatedAt: now
      });
      const identity = {
        conversationId: context.conversationId,
        piSessionId: context.piSessionId,
        productRunId: context.productRunId,
        interactionId
      } as const;
      const pending = input.broker.waitForAnswers({
        ...identity,
        interaction,
        ...(signal ? { signal } : {})
      });
      try {
        await input.reportRequested(interaction);
      } catch (error) {
        input.broker.cancelPending(identity);
        await pending.catch(() => undefined);
        throw error;
      }

      let answers: readonly Readonly<EchoInkQuestionAnswer>[];
      try {
        answers = await pending;
      } catch {
        const updatedAt = input.now?.() ?? Date.now();
        const record: Readonly<EchoInkTurnInteractionRecord> = Object.freeze({
          interactionId,
          kind: "question",
          outcome: "cancelled",
          summary: "用户未完成回答",
          updatedAt
        });
        appendInteractionRecord(input.sessionManager, context, record);
        await input.reportResolved(record).catch(() => undefined);
        throw new Error("用户取消了本次结构化问题。");
      }
      const updatedAt = input.now?.() ?? Date.now();
      const record: Readonly<EchoInkTurnInteractionRecord> = Object.freeze({
        interactionId,
        kind: "question",
        outcome: "answered",
        summary: questionAnswerSummary(interaction, answers),
        updatedAt
      });
      appendInteractionRecord(input.sessionManager, context, record);
      await input.reportResolved(record);
      input.security.complete(_toolCallId, {
        interactionId,
        outcome: "answered",
        questionCount: interaction.questions.length,
        text: questionAnswerText(interaction, answers)
      });
      return pendingQuestionResult(_toolCallId);
    }
  });
}

function appendInteractionRecord(
  sessionManager: SessionManager,
  context: Readonly<PiUserQuestionRunContext>,
  record: Readonly<EchoInkTurnInteractionRecord>
): string {
  if (sessionManager.getSessionId() !== context.piSessionId) {
    throw new Error("turn_interaction_session_identity_mismatch");
  }
  return sessionManager.appendCustomEntry(
    ECHOINK_TURN_INTERACTION_RECORD_ENTRY_TYPE,
    turnInteractionRecordEntryData({
      conversationId: context.conversationId,
      piSessionId: context.piSessionId,
      turnId: context.productRunId,
      record
    })
  );
}

function questionAnswerText(
  interaction: Readonly<EchoInkQuestionInteraction>,
  answers: readonly Readonly<EchoInkQuestionAnswer>[]
): string {
  return interaction.questions.map((question) => {
    const answer = answers.find((candidate) => candidate.questionId === question.questionId)!;
    const selected = question.options
      .filter((option) => answer.selectedOptionIds.includes(option.optionId))
      .map((option) => option.label);
    const parts = [selected.join("、"), answer.supplement?.trim()]
      .filter(Boolean);
    return `${question.prompt}\n回答：${parts.join("；")}`;
  }).join("\n\n");
}

function questionAnswerSummary(
  interaction: Readonly<EchoInkQuestionInteraction>,
  answers: readonly Readonly<EchoInkQuestionAnswer>[]
): string {
  const parts = interaction.questions.map((question) => {
    const answer = answers.find((candidate) => candidate.questionId === question.questionId);
    if (!answer) return "";
    const labels = question.options
      .filter((option) => answer.selectedOptionIds.includes(option.optionId))
      .map((option) => option.label);
    if (answer.supplement) labels.push(answer.supplement);
    return labels.join("、");
  }).filter(Boolean);
  const summary = `已回答：${parts.join("；")}`;
  return summary.length <= 1_000 ? summary : `${summary.slice(0, 999)}…`;
}

function normalizeRunContext(
  context: Readonly<PiUserQuestionRunContext>
): PiUserQuestionRunContext {
  return Object.freeze({
    conversationId: requiredIdentity(context.conversationId, "conversationId"),
    piSessionId: requiredIdentity(context.piSessionId, "piSessionId"),
    productRunId: requiredIdentity(context.productRunId, "productRunId")
  });
}

function requiredIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`turn_interaction_${label}_invalid`);
  return normalized;
}

function stableInteractionId(productRunId: string, toolCallId: string): string {
  const digest = createHash("sha256")
    .update(`${productRunId}\0${toolCallId}`)
    .digest("hex")
    .slice(0, 32);
  return `question:${digest}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeQuestionArguments(
  value: unknown
): readonly Readonly<EchoInkQuestionInteraction["questions"][number]>[] {
  return normalizeEchoInkQuestionPrompts(recordValue(value).questions);
}

function pendingQuestionResult(
  toolCallId: string
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text" as const, text: USER_QUESTION_RESULT_PENDING }],
    details: Object.freeze({
      source: "echoink-turn-interaction",
      toolCallId,
      status: "pending_safety"
    })
  };
}

function block(reason: string): Readonly<{ block: true; reason: string }> {
  return Object.freeze({ block: true, reason });
}

function rejectedResult(
  toolCallId: string,
  reason: string
): Readonly<{
  content: Array<{ type: "text"; text: string }>;
  details: Readonly<Record<string, unknown>>;
  isError: true;
}> {
  return Object.freeze({
    content: [{ type: "text" as const, text: reason }],
    details: Object.freeze({
      source: "echoink-turn-interaction",
      toolCallId,
      status: "failed"
    }),
    isError: true
  });
}
