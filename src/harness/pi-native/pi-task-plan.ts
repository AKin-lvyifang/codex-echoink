import { getDesktopUtil } from "../../platform/desktop-runtime";
import {
  defineTool,
  type AgentToolResult,
  type SessionManager,
  type ToolCallEvent,
  type ToolDefinition,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import {
  ECHOINK_TASK_PLAN_ENTRY_TYPE,
  ECHOINK_TASK_PLAN_SCHEMA_VERSION,
  ECHOINK_TASK_PLAN_STEP_STATUSES,
  ECHOINK_TASK_PLAN_STATUSES,
  activeTaskPlanFromBranch,
  freezeEchoInkTaskPlan,
  isEchoInkTaskPlanTerminal,
  latestTaskPlanFromBranch,
  normalizeEchoInkTaskPlanDraft,
  taskPlanCurrentStep,
  taskPlanSessionEntryData,
  type EchoInkTaskPlanDraft,
  type EchoInkTaskPlanSnapshot,
  type EchoInkTaskPlanStatus
} from "../../types/task-plan";

const { isDeepStrictEqual } = getDesktopUtil();

export const PI_TASK_UPDATE_TOOL_ID = "task_update" as const;

const TASK_PLAN_RESULT_PENDING = "task_plan_result_pending_safety";

export interface PiTaskPlanRunContext {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly mode: "agent" | "plan";
}

export type EchoInkTaskPlanUserAction =
  | "execute"
  | "continue"
  | "pause"
  | "cancel";

interface AuthorizedTaskPlanUpdate {
  readonly context: Readonly<PiTaskPlanRunContext>;
  readonly draft: Readonly<EchoInkTaskPlanDraft>;
  readonly previous: Readonly<EchoInkTaskPlanSnapshot> | null;
  state: "authorized" | "consumed" | "result_ready";
  result?: Readonly<EchoInkTaskPlanSnapshot>;
}

export class PiTaskPlanToolSecurity
implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_TASK_UPDATE_TOOL_ID;

  private readonly executions = new Map<string, AuthorizedTaskPlanUpdate>();
  private readonly seenToolCallIds = new Set<string>();
  private correctionRunId = "";
  private validationFailures = 0;

  constructor(private readonly options: Readonly<{
    sessionManager: SessionManager;
    currentRun(): Readonly<PiTaskPlanRunContext>;
    now?: () => number;
  }>) {
    if (!options.sessionManager) {
      throw new TypeError("task_plan_session_manager_required");
    }
  }

  async handleToolCall(
    event: ToolCallEvent,
    _signal: AbortSignal | undefined
  ): Promise<Readonly<{ block: true; reason: string }> | void> {
    if (event.toolName !== this.toolName) {
      return block("tool_policy_blocked");
    }
    if (this.seenToolCallIds.has(event.toolCallId)) {
      return block("authorization_failed");
    }
    this.seenToolCallIds.add(event.toolCallId);
    try {
      const context = normalizeRunContext(this.options.currentRun());
      if (context.productRunId !== this.correctionRunId) {
        this.correctionRunId = context.productRunId;
        this.validationFailures = 0;
      }
      if (context.mode === "plan" && this.validationFailures >= 2) {
        return block("计划参数修正仍未通过，请停止重试并向用户说明本次未生成计划。The single correction attempt was used; stop retrying and explain that no plan was created.");
      }
      let draft: Readonly<EchoInkTaskPlanDraft>;
      try {
        draft = normalizeEchoInkTaskPlanDraft(event.input);
      } catch (error) {
        if (context.mode !== "plan") return block("tool_policy_blocked");
        return block(this.validationFailureReason(error));
      }
      const branch = this.options.sessionManager.getBranch();
      const active = activeTaskPlanFromBranch(branch);
      const previous = latestTaskPlanFromBranch(branch, draft.planId);
      assertTaskPlanToolUpdateAllowed(context, draft, active, previous);
      this.executions.set(event.toolCallId, {
        context,
        draft,
        previous,
        state: "authorized"
      });
    } catch {
      return block("tool_policy_blocked");
    }
  }

  private validationFailureReason(error: unknown): string {
    this.validationFailures += 1;
    const reason = error instanceof TypeError ? error.message : "task_plan_arguments_invalid";
    return `计划参数校验失败 / Invalid plan arguments: ${reason}. planId、stepId、currentStepId 只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，首字符必须为字母或数字；步骤不得为空，规划状态须为 pending。${this.validationFailures === 1 ? "请修正后再调用一次 task_update（只允许一次修正）。Correct the arguments and retry task_update once." : "修正仍未通过，请停止重试，说明本次未生成计划。Correction failed; stop retrying."}`;
  }

  consume(
    toolCallId: string,
    rawArguments: unknown
  ): Readonly<AuthorizedTaskPlanUpdate> {
    const execution = this.executions.get(toolCallId);
    if (!execution || execution.state !== "authorized") {
      throw new Error("task_plan_authorization_failed");
    }
    const normalized = normalizeEchoInkTaskPlanDraft(rawArguments);
    if (!isDeepStrictEqual(normalized, execution.draft)) {
      throw new Error("task_plan_authorization_failed");
    }
    execution.state = "consumed";
    return execution;
  }

  complete(
    toolCallId: string,
    result: Readonly<EchoInkTaskPlanSnapshot>
  ): void {
    const execution = this.executions.get(toolCallId);
    if (!execution || execution.state !== "consumed") {
      throw new Error("task_plan_authorization_failed");
    }
    execution.result = result;
    execution.state = "result_ready";
  }

  async handleToolResult(event: ToolResultEvent): Promise<Readonly<{
    content: Array<{ type: "text"; text: string }>;
    details: Readonly<Record<string, unknown>>;
    isError: boolean;
  }>> {
    const execution = this.executions.get(event.toolCallId);
    // Pi validates its JSON schema before tool_call. Preserve a correctable
    // argument error from that path instead of replacing it with authorization_failed.
    if (event.toolName === this.toolName && event.isError && !execution && !this.seenToolCallIds.has(event.toolCallId)) {
      try {
        const context = normalizeRunContext(this.options.currentRun());
        if (context.mode === "plan") {
          if (context.productRunId !== this.correctionRunId) {
            this.correctionRunId = context.productRunId;
            this.validationFailures = 0;
          }
          this.seenToolCallIds.add(event.toolCallId);
          try { normalizeEchoInkTaskPlanDraft(event.input); }
          catch (error) {
            const schemaReason = event.content.filter(part => part.type === "text").map(part => part.text)
              .join("\n").split("\n\nReceived arguments:")[0].slice(0, 800);
            return rejectedResult(event.toolCallId, this.validationFailureReason(
              new TypeError(`${error instanceof TypeError ? error.message : "task_plan_arguments_invalid"}; ${schemaReason}`)));
          }
        }
      } catch { /* No active planning turn: keep the original fail-closed behavior. */ }
    }
    if (
      event.toolName !== this.toolName
      || !execution
      || execution.state !== "result_ready"
      || !execution.result
    ) {
      this.executions.delete(event.toolCallId);
      return rejectedResult(event.toolCallId, "authorization_failed");
    }
    try {
      return Object.freeze({
        content: [{
          type: "text" as const,
          text: `任务计划已更新：${execution.result.planId} v${execution.result.version}`
        }],
        details: Object.freeze({
          source: "echoink-task-plan",
          schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
          toolCallId: event.toolCallId,
          conversationId: execution.context.conversationId,
          piSessionId: execution.context.piSessionId,
          productRunId: execution.context.productRunId,
          plan: execution.result
        }),
        isError: false
      });
    } finally {
      this.executions.delete(event.toolCallId);
    }
  }

  now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function createPiTaskPlanToolDefinition(input: Readonly<{
  sessionManager: SessionManager;
  security: PiTaskPlanToolSecurity;
}>): ToolDefinition {
  const statusSchema = Type.Union(
    ECHOINK_TASK_PLAN_STATUSES.map((status) => Type.Literal(status))
  );
  const stepStatusSchema = Type.Union(
    ECHOINK_TASK_PLAN_STEP_STATUSES.map((status) => Type.Literal(status))
  );
  return defineTool({
    name: PI_TASK_UPDATE_TOOL_ID,
    label: "更新任务计划",
    description: [
      "把当前 Conversation 的完整任务计划快照写入同一个 Pi Session。",
      "每次调用都必须提供同一个 planId、标题、全部步骤及其结构化状态；版本由 EchoInk 自动递增。",
      "禁止用 Markdown、[DONE:n] 或自然语言标记代替此 Tool。"
    ].join(""),
    parameters: Type.Object({
      planId: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: 200 }),
      status: statusSchema,
      steps: Type.Array(Type.Object({
        stepId: Type.String({ minLength: 1, maxLength: 128 }),
        text: Type.String({ minLength: 1, maxLength: 2_000 }),
        status: stepStatusSchema,
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
      }, { additionalProperties: false }), {
        minItems: 1,
        maxItems: 64
      }),
      currentStepId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (toolCallId, rawArguments) => {
      const authorized = input.security.consume(toolCallId, rawArguments);
      const result = snapshotFromToolUpdate(
        authorized.draft,
        authorized.previous,
        authorized.context.productRunId,
        input.security.now()
      );
      appendTaskPlanEntry(input.sessionManager, authorized.context, result);
      input.security.complete(toolCallId, result);
      return pendingResult(toolCallId, authorized.context, result);
    }
  });
}

export function appendTaskPlanEntry(
  sessionManager: SessionManager,
  identity: Readonly<Pick<
    PiTaskPlanRunContext,
    "conversationId" | "piSessionId"
  >>,
  plan: Readonly<EchoInkTaskPlanSnapshot>
): string {
  if (sessionManager.getSessionId() !== identity.piSessionId) {
    throw new Error("task_plan_session_identity_mismatch");
  }
  return sessionManager.appendCustomEntry(
    ECHOINK_TASK_PLAN_ENTRY_TYPE,
    taskPlanSessionEntryData({
      conversationId: identity.conversationId,
      piSessionId: identity.piSessionId,
      plan
    })
  );
}

export function transitionTaskPlanByUser(input: Readonly<{
  plan: Readonly<EchoInkTaskPlanSnapshot>;
  action: EchoInkTaskPlanUserAction;
  updatedAt: number;
  productRunId?: string;
}>): Readonly<EchoInkTaskPlanSnapshot> {
  const plan = input.plan;
  const steps = plan.steps.map((step) => ({ ...step }));
  let currentStepId: string | undefined;
  let status: EchoInkTaskPlanStatus;
  let summary: string;

  if (input.action === "execute" || input.action === "continue") {
    if (
      input.action === "execute"
        ? plan.status !== "pending"
        : plan.status !== "paused"
    ) throw new Error("task_plan_user_transition_invalid");
    const current = input.action === "continue"
      ? taskPlanCurrentStep(plan)
      : steps.find((step) =>
          step.status !== "completed" && step.status !== "cancelled"
        ) ?? null;
    if (!current) throw new Error("task_plan_current_step_missing");
    currentStepId = current.stepId;
    for (const step of steps) {
      if (step.stepId !== currentStepId) continue;
      step.status = "in_progress";
      delete step.reason;
    }
    status = "in_progress";
    summary = input.action === "execute" ? "用户开始执行计划" : "用户继续执行计划";
  } else if (input.action === "pause") {
    if (plan.status !== "in_progress" || !plan.currentStepId) {
      throw new Error("task_plan_user_transition_invalid");
    }
    currentStepId = plan.currentStepId;
    for (const step of steps) {
      if (step.stepId === currentStepId && step.status === "in_progress") {
        step.status = "paused";
      }
    }
    status = "paused";
    summary = "用户暂停计划";
  } else {
    if (
      plan.status !== "pending"
      && plan.status !== "in_progress"
      && plan.status !== "paused"
    ) throw new Error("task_plan_user_transition_invalid");
    for (const step of steps) {
      if (step.status !== "completed") {
        step.status = "cancelled";
        delete step.reason;
      }
    }
    status = "cancelled";
    summary = "用户取消计划";
  }

  return freezeEchoInkTaskPlan({
    ...plan,
    status,
    version: plan.version + 1,
    steps,
    ...(currentStepId ? { currentStepId } : {}),
    ...(!currentStepId ? { currentStepId: undefined } : {}),
    reason: undefined,
    lastUpdateSummary: summary,
    source: "user",
    ...(input.productRunId ? { productRunId: input.productRunId } : {}),
    updatedAt: input.updatedAt
  });
}

export function taskPlanSteeringSnapshot(input: Readonly<{
  plan: Readonly<EchoInkTaskPlanSnapshot>;
  directive: string;
  updatedAt: number;
  productRunId: string;
}>): Readonly<EchoInkTaskPlanSnapshot> {
  const directive = input.directive.trim();
  if (!directive || directive.length > 500 || input.plan.status !== "in_progress") {
    throw new Error("task_plan_steering_invalid");
  }
  return freezeEchoInkTaskPlan({
    ...input.plan,
    version: input.plan.version + 1,
    lastUpdateSummary: `用户调整方向：${directive}`,
    source: "user",
    productRunId: input.productRunId,
    updatedAt: input.updatedAt
  });
}

export function pauseTaskPlanForRuntime(input: Readonly<{
  plan: Readonly<EchoInkTaskPlanSnapshot>;
  updatedAt: number;
  productRunId: string;
  summary: string;
}>): Readonly<EchoInkTaskPlanSnapshot> {
  if (input.plan.status !== "in_progress" || !input.plan.currentStepId) {
    throw new Error("task_plan_runtime_pause_invalid");
  }
  const summary = input.summary.trim();
  if (!summary || summary.length > 500) {
    throw new Error("task_plan_runtime_pause_invalid");
  }
  const steps = input.plan.steps.map((step) => ({
    ...step,
    ...(step.stepId === input.plan.currentStepId
      ? { status: "paused" as const }
      : {})
  }));
  return freezeEchoInkTaskPlan({
    ...input.plan,
    status: "paused",
    version: input.plan.version + 1,
    steps,
    currentStepId: input.plan.currentStepId,
    reason: undefined,
    lastUpdateSummary: summary,
    source: "agent",
    productRunId: input.productRunId,
    updatedAt: Math.max(input.plan.updatedAt, input.updatedAt)
  });
}

export function failTaskPlanForProductRun(input: Readonly<{
  plan: Readonly<EchoInkTaskPlanSnapshot>;
  updatedAt: number;
  productRunId: string;
  reason: string;
}>): Readonly<EchoInkTaskPlanSnapshot> {
  if (isEchoInkTaskPlanTerminal(input.plan.status)) {
    throw new Error("task_plan_runtime_failure_invalid");
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new Error("task_plan_runtime_failure_invalid");
  }
  const steps = input.plan.steps.map((step) => ({
    ...step,
    ...(step.status === "in_progress" || step.status === "paused"
      ? { status: "interrupted" as const }
      : {})
  }));
  return freezeEchoInkTaskPlan({
    ...input.plan,
    status: "failed",
    version: input.plan.version + 1,
    steps,
    currentStepId: undefined,
    reason,
    lastUpdateSummary: "本轮执行失败，任务已停止",
    source: "agent",
    productRunId: input.productRunId,
    updatedAt: Math.max(input.plan.updatedAt, input.updatedAt)
  });
}

function snapshotFromToolUpdate(
  draft: Readonly<EchoInkTaskPlanDraft>,
  previous: Readonly<EchoInkTaskPlanSnapshot> | null,
  productRunId: string,
  updatedAt: number
): Readonly<EchoInkTaskPlanSnapshot> {
  return freezeEchoInkTaskPlan({
    schemaVersion: ECHOINK_TASK_PLAN_SCHEMA_VERSION,
    ...draft,
    version: (previous?.version ?? 0) + 1,
    source: "agent",
    productRunId,
    createdAt: previous?.createdAt ?? updatedAt,
    updatedAt: Math.max(previous?.updatedAt ?? updatedAt, updatedAt)
  });
}

function assertTaskPlanToolUpdateAllowed(
  context: Readonly<PiTaskPlanRunContext>,
  draft: Readonly<EchoInkTaskPlanDraft>,
  active: Readonly<EchoInkTaskPlanSnapshot> | null,
  previous: Readonly<EchoInkTaskPlanSnapshot> | null
): void {
  if (previous) assertCompletedStepsPreserved(previous, draft);
  if (context.mode === "plan") {
    if (
      draft.status !== "pending"
      || (active && active.planId !== draft.planId)
      || (previous && isEchoInkTaskPlanTerminal(previous.status))
    ) throw new Error("task_plan_planning_update_blocked");
    return;
  }
  if (
    !active
    || active.planId !== draft.planId
    || previous?.planId !== active.planId
    || active.status !== "in_progress"
    || draft.status === "pending"
    || !executionTransitionAllowed(active.status, draft.status)
  ) throw new Error("task_plan_execution_update_blocked");

}

function assertCompletedStepsPreserved(
  previous: Readonly<EchoInkTaskPlanSnapshot>,
  next: Readonly<EchoInkTaskPlanDraft>
): void {
  const nextById = new Map(next.steps.map((step) => [step.stepId, step]));
  for (const step of previous.steps) {
    if (step.status !== "completed") continue;
    if (nextById.get(step.stepId)?.status !== "completed") {
      throw new Error("task_plan_completed_step_regressed");
    }
  }
}

function executionTransitionAllowed(
  previous: EchoInkTaskPlanStatus,
  next: EchoInkTaskPlanStatus
): boolean {
  if (previous === "in_progress") {
    return next === "in_progress"
      || next === "completed"
      || next === "failed"
      || next === "paused"
      || next === "cancelled";
  }
  return false;
}

function normalizeRunContext(
  value: Readonly<PiTaskPlanRunContext>
): Readonly<PiTaskPlanRunContext> {
  if (
    !nonEmpty(value?.conversationId)
    || !nonEmpty(value.piSessionId)
    || !nonEmpty(value.productRunId)
    || (value.mode !== "agent" && value.mode !== "plan")
  ) throw new TypeError("task_plan_run_context_invalid");
  return Object.freeze({ ...value });
}

function pendingResult(
  toolCallId: string,
  context: Readonly<PiTaskPlanRunContext>,
  plan: Readonly<EchoInkTaskPlanSnapshot>
): AgentToolResult<Readonly<Record<string, unknown>>> {
  return {
    content: [{ type: "text", text: TASK_PLAN_RESULT_PENDING }],
    details: Object.freeze({
      source: "echoink-task-plan",
      toolCallId,
      productRunId: context.productRunId,
      piSessionId: context.piSessionId,
      plan
    })
  };
}

function rejectedResult(
  toolCallId: string,
  reason: string
): Readonly<{
  content: Array<{ type: "text"; text: string }>;
  details: Readonly<Record<string, unknown>>;
  isError: boolean;
}> {
  return Object.freeze({
    content: [{ type: "text" as const, text: reason }],
    details: Object.freeze({
      source: "echoink-task-plan",
      toolCallId,
      reason
    }),
    isError: true
  });
}

function block(reason: string): Readonly<{ block: true; reason: string }> {
  return Object.freeze({ block: true, reason });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
