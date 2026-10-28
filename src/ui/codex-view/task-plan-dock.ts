import { attachNativeTooltip } from "../native-tooltip";
import { setIcon } from "obsidian";
import type { ChatMessage, SettingsLanguage } from "../../settings/settings";
import {
  taskPlanProgress,
  type EchoInkTaskPlanSnapshot,
  type EchoInkTaskPlanStatus,
  type EchoInkTaskPlanStep,
  type EchoInkTaskPlanStepStatus
} from "../../types/task-plan";
import { markSmoothAITaskList } from "./smooth-chat-ui";
import { conversationUiText } from "./ui-i18n";

export const TASK_PLAN_DOCK_CLOSEOUT_MS = 2_000;

export interface TaskPlanDockClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface TaskPlanDockRenderInput {
  readonly sessionId: string;
  readonly language?: SettingsLanguage;
  readonly messages: readonly Readonly<ChatMessage>[];
  readonly onAction?: (
    planId: string,
    action: "execute" | "continue" | "pause" | "cancel"
  ) => Promise<void>;
  readonly onModify?: (planId: string, title: string) => void;
}

interface TaskPlanDockPresentationState {
  expanded: boolean;
  manuallyExpanded: boolean;
  completionHandled: boolean;
  hiddenAfterCompletion: boolean;
}

interface ScheduledCloseout {
  handle: number;
  key: string;
  version: number;
}

export interface SelectedTaskPlan {
  readonly message: Readonly<ChatMessage>;
  readonly plan: Readonly<EchoInkTaskPlanSnapshot>;
}

export function selectTaskPlanForDock(
  messages: readonly Readonly<ChatMessage>[]
): SelectedTaskPlan | null {
  let selected: SelectedTaskPlan | null = null;
  let selectedIndex = -1;
  for (const [index, message] of messages.entries()) {
    const plan = message.taskPlan;
    if (!plan) continue;
    if (
      !selected
      || plan.updatedAt > selected.plan.updatedAt
      || (
        plan.updatedAt === selected.plan.updatedAt
        && plan.version > selected.plan.version
      )
      || (
        plan.updatedAt === selected.plan.updatedAt
        && plan.version === selected.plan.version
        && index > selectedIndex
      )
    ) {
      selected = { message, plan };
      selectedIndex = index;
    }
  }
  return selected;
}

export class TaskPlanDockController {
  private readonly states = new Map<string, TaskPlanDockPresentationState>();
  private activeSessionId = "";
  private scheduledCloseout: ScheduledCloseout | null = null;
  private lastRender: Readonly<{
    container: HTMLElement;
    input: TaskPlanDockRenderInput;
  }> | null = null;

  constructor(private readonly clock: TaskPlanDockClock = browserClock()) {}

  render(container: HTMLElement, input: TaskPlanDockRenderInput): void {
    if (input.sessionId !== this.activeSessionId) {
      this.cancelCloseout(true);
      this.activeSessionId = input.sessionId;
    }
    this.lastRender = { container, input };
    const selected = selectTaskPlanForDock(input.messages);
    if (!selected) {
      this.cancelCloseout();
      hideDock(container);
      return;
    }
    const { plan } = selected;
    const key = dockStateKey(input.sessionId, plan.planId);
    if (
      this.scheduledCloseout
      && (
        this.scheduledCloseout.key !== key
        || this.scheduledCloseout.version !== plan.version
        || plan.status !== "completed"
      )
    ) this.cancelCloseout();
    const state = this.stateFor(key);
    this.prepareCompletionCloseout(key, plan, state);
    if (state.hiddenAfterCompletion) {
      hideDock(container);
      return;
    }
    renderTaskPlanDock(container, plan, state, {
      onToggle: () => {
        state.expanded = !state.expanded;
        if (state.expanded) state.manuallyExpanded = true;
        if (plan.status === "completed" && state.manuallyExpanded) {
          state.completionHandled = true;
          this.cancelCloseout();
        }
        this.render(container, input);
      },
      onAction: input.onAction,
      onModify: input.onModify
    }, input.language ?? "zh-CN");
  }

  dispose(): void {
    this.cancelCloseout();
    this.lastRender = null;
    this.activeSessionId = "";
  }

  private stateFor(key: string): TaskPlanDockPresentationState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const created = {
      expanded: false,
      manuallyExpanded: false,
      completionHandled: false,
      hiddenAfterCompletion: false
    };
    this.states.set(key, created);
    return created;
  }

  private prepareCompletionCloseout(
    key: string,
    plan: Readonly<EchoInkTaskPlanSnapshot>,
    state: TaskPlanDockPresentationState
  ): void {
    if (plan.status !== "completed" || state.completionHandled) return;
    if (state.manuallyExpanded) {
      state.completionHandled = true;
      return;
    }
    if (this.scheduledCloseout) return;
    const remaining = TASK_PLAN_DOCK_CLOSEOUT_MS
      - Math.max(0, this.clock.now() - plan.updatedAt);
    if (remaining <= 0) {
      state.completionHandled = true;
      state.hiddenAfterCompletion = true;
      return;
    }
    const version = plan.version;
    const handle = this.clock.setTimeout(() => {
      if (
        !this.scheduledCloseout
        || this.scheduledCloseout.key !== key
        || this.scheduledCloseout.version !== version
      ) return;
      this.scheduledCloseout = null;
      const latestRender = this.lastRender;
      const latest = latestRender
        ? selectTaskPlanForDock(latestRender.input.messages)
        : null;
      if (
        !latestRender
        || latestRender.input.sessionId !== this.activeSessionId
        || dockStateKey(latestRender.input.sessionId, latest?.plan.planId ?? "") !== key
        || latest?.plan.version !== version
        || latest?.plan.status !== "completed"
      ) return;
      const latestState = this.stateFor(key);
      latestState.completionHandled = true;
      if (!latestState.manuallyExpanded) {
        latestState.hiddenAfterCompletion = true;
      }
      this.render(latestRender.container, latestRender.input);
    }, remaining);
    this.scheduledCloseout = { handle, key, version };
  }

  private cancelCloseout(finishPresentation = false): void {
    if (!this.scheduledCloseout) return;
    if (finishPresentation) {
      const state = this.states.get(this.scheduledCloseout.key);
      if (state) {
        state.completionHandled = true;
        if (!state.manuallyExpanded) state.hiddenAfterCompletion = true;
      }
    }
    this.clock.clearTimeout(this.scheduledCloseout.handle);
    this.scheduledCloseout = null;
  }
}

function renderTaskPlanDock(
  container: HTMLElement,
  plan: Readonly<EchoInkTaskPlanSnapshot>,
  state: TaskPlanDockPresentationState,
  callbacks: Readonly<{
    onToggle(): void;
    onAction?: TaskPlanDockRenderInput["onAction"];
    onModify?: TaskPlanDockRenderInput["onModify"];
  }>,
  language: SettingsLanguage
): void {
  container.empty();
  container.addClass("is-visible");
  container.dataset.sessionTaskPlanId = plan.planId;
  const progress = taskPlanProgress(plan);
  const card = container.createDiv({
    cls: `codex-task-plan-card codex-task-plan-dock-card is-${plan.status}`,
    attr: {
      "aria-label": conversationUiText(language, `当前任务：${plan.title}`, `Current task: ${plan.title}`)
    }
  });
  markSmoothAITaskList(card);
  const contentId = `codex-task-plan-dock-${safeDomIdentity(plan.planId)}`;
  const header = card.createEl("button", {
    cls: "codex-task-plan-header",
    attr: {
      type: "button",
      "aria-controls": contentId,
      "aria-expanded": String(state.expanded)
    }
  });
  renderStatusIcon(
    header.createSpan({ cls: "codex-task-plan-status" }),
    plan.status,
    language
  );
  const heading = header.createSpan({ cls: "codex-task-plan-heading" });
  heading.createSpan({ cls: "codex-task-plan-title", text: plan.title });
  heading.createSpan({
    cls: "codex-task-plan-progress",
    text: taskPlanDockStatus(plan.status, progress.current, progress.total, language)
  });
  attachNativeTooltip(header, state.expanded
    ? conversationUiText(language, "收起当前任务", "Collapse current task")
    : conversationUiText(language, "展开当前任务", "Expand current task"));
  const disclosure = header.createSpan({
    cls: "codex-task-plan-disclosure",
    attr: { "aria-hidden": "true" }
  });
  setIcon(disclosure, state.expanded ? "chevron-up" : "chevron-down");
  header.onclick = callbacks.onToggle;

  const body = card.createDiv({
    cls: "codex-task-plan-dock-content",
    attr: { id: contentId }
  });
  if (state.expanded) {
    const steps = body.createDiv({ cls: "codex-task-plan-steps" });
    for (const step of plan.steps) renderStep(steps, step, language);
    if (plan.reason) {
      body.createDiv({ cls: "codex-task-plan-reason", text: plan.reason });
    }
    renderActions(body, plan, callbacks, language);
    return;
  }
  const currentStep = explicitCurrentStep(plan);
  if (currentStep) {
    const steps = body.createDiv({ cls: "codex-task-plan-steps" });
    const row = renderStep(steps, currentStep, language);
    row.addClass("codex-task-plan-step-current");
  }
}

function renderStep(
  container: HTMLElement,
  step: Readonly<EchoInkTaskPlanStep>,
  language: SettingsLanguage
): HTMLElement {
  const row = container.createDiv({
    cls: `codex-task-plan-step is-${step.status}`
  });
  renderStatusIcon(
    row.createSpan({ cls: "codex-task-plan-step-status" }),
    step.status,
    language
  );
  const copy = row.createDiv({ cls: "codex-task-plan-step-copy" });
  copy.createDiv({ cls: "codex-task-plan-step-text", text: step.text });
  if (step.reason) {
    copy.createDiv({ cls: "codex-task-plan-step-reason", text: step.reason });
  }
  return row;
}

function renderActions(
  container: HTMLElement,
  plan: Readonly<EchoInkTaskPlanSnapshot>,
  callbacks: Readonly<{
    onAction?: TaskPlanDockRenderInput["onAction"];
    onModify?: TaskPlanDockRenderInput["onModify"];
  }>,
  language: SettingsLanguage
): void {
  const actions = container.createDiv({ cls: "codex-task-plan-actions" });
  const addAction = (
    label: string,
    action: "execute" | "continue" | "pause" | "cancel",
    tone: "primary" | "secondary" | "danger"
  ) => {
    if (!callbacks.onAction) return;
    const button = actions.createEl("button", {
      cls: `codex-task-plan-action is-${tone}`,
      text: label,
      attr: { type: "button" }
    });
    button.onclick = async () => {
      if (button.disabled) return;
      setActionsBusy(actions, true);
      try {
        await callbacks.onAction?.(plan.planId, action);
      } finally {
        if (actions.isConnected) setActionsBusy(actions, false);
      }
    };
  };
  const addModify = () => {
    if (!callbacks.onModify) return;
    const button = actions.createEl("button", {
      cls: "codex-task-plan-action is-secondary",
      text: conversationUiText(language, "修改计划", "Edit plan"),
      attr: { type: "button" }
    });
    button.onclick = () => callbacks.onModify?.(plan.planId, plan.title);
  };
  if (plan.status === "pending") {
    addAction(conversationUiText(language, "执行", "Run"), "execute", "primary");
    addModify();
    addAction(conversationUiText(language, "取消", "Cancel"), "cancel", "danger");
  } else if (plan.status === "in_progress") {
    addAction(conversationUiText(language, "暂停/中止", "Pause / stop"), "pause", "danger");
  } else if (plan.status === "paused") {
    addAction(conversationUiText(language, "继续", "Continue"), "continue", "primary");
    addModify();
    addAction(conversationUiText(language, "取消", "Cancel"), "cancel", "danger");
  }
  if (!actions.childElementCount) actions.remove();
}

function explicitCurrentStep(
  plan: Readonly<EchoInkTaskPlanSnapshot>
): Readonly<EchoInkTaskPlanStep> | null {
  if (!plan.currentStepId) return null;
  return plan.steps.find((step) =>
    step.stepId === plan.currentStepId
    && (step.status === "in_progress" || step.status === "paused")
  ) ?? null;
}

function renderStatusIcon(
  container: HTMLElement,
  status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus,
  language: SettingsLanguage = "zh-CN"
): void {
  container.addClass(`is-${status}`);
  container.setAttribute("role", "img");
  container.setAttribute("aria-label", statusLabel(status, language));
  setIcon(container, statusIcon(status));
}

function taskPlanDockStatus(
  status: EchoInkTaskPlanStatus,
  current: number,
  total: number,
  language: SettingsLanguage = "zh-CN"
): string {
  if (status === "completed") return conversationUiText(language, `${current}/${total} · 已完成`, `${current}/${total} · Completed`);
  if (status === "failed") return conversationUiText(language, "任务失败", "Task failed");
  if (status === "cancelled") return conversationUiText(language, "已取消", "Cancelled");
  if (status === "paused") return conversationUiText(language, `${current}/${total} · 已中断，可继续`, `${current}/${total} · Interrupted, can continue`);
  if (status === "pending") return conversationUiText(language, `${current}/${total} · 等待开始`, `${current}/${total} · Waiting to start`);
  return conversationUiText(language, `${current}/${total} · 进行中`, `${current}/${total} · In progress`);
}

function statusLabel(
  status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus,
  language: SettingsLanguage = "zh-CN"
): string {
  if (status === "pending") return conversationUiText(language, "待执行", "Pending");
  if (status === "in_progress") return conversationUiText(language, "进行中", "In progress");
  if (status === "completed") return conversationUiText(language, "已完成", "Completed");
  if (status === "failed") return conversationUiText(language, "失败", "Failed");
  if (status === "paused") return conversationUiText(language, "已暂停", "Paused");
  if (status === "interrupted") return conversationUiText(language, "已中断", "Interrupted");
  return conversationUiText(language, "已取消", "Cancelled");
}

function statusIcon(
  status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus
): string {
  if (status === "pending") return "circle";
  if (status === "in_progress") return "loader-circle";
  if (status === "completed") return "circle-check";
  if (status === "failed") return "circle-alert";
  if (status === "paused" || status === "interrupted") return "circle-pause";
  return "circle-x";
}

function setActionsBusy(container: HTMLElement, busy: boolean): void {
  container.toggleClass("is-busy", busy);
  for (const button of Array.from(
    container.querySelectorAll<HTMLButtonElement>("button")
  )) button.disabled = busy;
}

function hideDock(container: HTMLElement): void {
  container.empty();
  container.removeClass("is-visible");
  delete container.dataset.sessionTaskPlanId;
}

function dockStateKey(sessionId: string, planId: string): string {
  return `${sessionId}\u0000${planId}`;
}

function safeDomIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-").slice(-160);
}

function browserClock(): TaskPlanDockClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle)
  };
}
