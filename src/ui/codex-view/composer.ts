import { setIcon } from "obsidian";
import type { EchoInkResource } from "../../resources/types";
import type { AgentBackendMode, StoredAttachment, StoredSession } from "../../settings/settings";
import type { PermissionMode, ReasoningEffort, UiMode } from "../../types/app-server";
import { composerPrimaryActionForState, composerStateForRuntimeState } from "../composer-state";
import { handleKnowledgeCommandMenuKeyDown } from "../knowledge-command-menu";
import type { QueuedTurnItem } from "../turn-queue";

let knowledgeCommandMenuId = 0;

export interface ComposerShellRefs {
  queueEl: HTMLElement;
  attachmentsEl: HTMLElement;
  workspaceEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  promptEnhanceReviewEl: HTMLElement;
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
  toolbarEl: HTMLElement;
}

export interface ComposerShellCallbacks {
  onInputChanged: () => void;
  onPasteFiles: (event: ClipboardEvent) => void;
  onEnhancePrompt: () => void;
  onSendMessage: () => void;
  onDropFiles: (event: DragEvent) => void;
}

export interface ComposerToolbarState {
  session: StoredSession;
  knowledgeSession: boolean;
  knowledgeTaskRunning: boolean;
  knowledgeBackend: AgentBackendMode;
  selectedSkill: EchoInkResource | null;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  running: boolean;
  promptEnhancerRunning: boolean;
  viewRunKind?: "chat" | "knowledge-base" | "editor" | "";
  hasDraft: boolean;
  hasQueuedItems: boolean;
  currentComposerModel: string;
  currentComposerReasoning: string;
  currentComposerSummaryTitle: string;
  currentKnowledgeComposerSummaryTitle: string;
  workspacePath: string;
  workspaceDisplayName: string;
  workspaceValid: boolean;
}

export interface ComposerToolbarRefs {
  contextEl?: HTMLElement;
  contextRingEl?: HTMLElement;
  contextValueEl?: HTMLElement;
}

export interface ComposerToolbarCallbacks {
  onOpenAddMenu: (event: MouseEvent) => void;
  onOpenSkillMenu: (event: MouseEvent) => void;
  onEnhancePrompt: () => void;
  onCaptureKnowledgeSource: () => void;
  onOpenKnowledgeModelMenu: (event: MouseEvent) => void;
  onOpenKnowledgeCommandMenu: (event: MouseEvent) => void;
  onPermissionChange: (value: PermissionMode) => void;
  onOpenWorkspaceMenu: (event: MouseEvent, session: StoredSession) => void;
  onOpenModelMenu: (event: MouseEvent) => void;
  onMicInput: () => void;
  onCancelKnowledgeTask: () => void;
  onStopTurn: () => void;
  onEnqueueDraft: () => void;
  onResumeQueue: (sessionId: string) => void;
  onSendMessage: () => void;
}

export interface TurnQueueState {
  items: QueuedTurnItem[];
  paused: boolean;
  canResume: boolean;
  draggedItemId: string;
}

export interface TurnQueueCallbacks {
  onResume: () => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onReorder: (sessionId: string, sourceId: string, targetIndex: number) => void;
  onRemove: (sessionId: string, itemId: string) => void;
}

export interface ComposerAttachmentsState {
  selectedSkill: EchoInkResource | null;
  attachments: StoredAttachment[];
}

export interface ComposerAttachmentsCallbacks {
  onRemoveSkill: () => void;
  onRemoveAttachment: (path: string) => void;
}

export function shouldShowComposerPlanIndicator(knowledgeSession: boolean, selectedMode: UiMode): boolean {
  return !knowledgeSession && selectedMode === "plan";
}

export function renderComposerShell(rootEl: HTMLElement, callbacks: ComposerShellCallbacks): ComposerShellRefs {
  const inputWrap = rootEl.createDiv({ cls: "codex-input-wrap" });
  const queueEl = inputWrap.createDiv({ cls: "codex-turn-queue" });
  const attachmentsEl = inputWrap.createDiv({ cls: "codex-attachments" });
  const workspaceEl = inputWrap.createDiv({ cls: "codex-composer-workspace" });
  const commandMenuId = `codex-knowledge-command-menu-${++knowledgeCommandMenuId}`;
  const inputEl = inputWrap.createEl("textarea", {
    cls: "codex-input",
    attr: {
      placeholder: "问 Codex，让它管理当前 Obsidian 仓库",
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": commandMenuId
    }
  });
  const promptEnhanceReviewEl = inputWrap.createDiv({ cls: "codex-composer-enhance-review" });
  const skillMenuEl = inputWrap.createDiv({ cls: "codex-skill-menu" });
  const knowledgeCommandMenuEl = inputWrap.createDiv({
    cls: "codex-knowledge-command-menu",
    attr: { id: commandMenuId, role: "listbox", "aria-label": "知识库命令" }
  });
  const toolbarEl = inputWrap.createDiv({ cls: "codex-toolbar" });
  inputEl.addEventListener("input", callbacks.onInputChanged);
  inputEl.addEventListener("paste", callbacks.onPasteFiles);
  inputEl.addEventListener("keydown", (event) => {
    if (handleKnowledgeCommandMenuKeyDown(event, inputEl, knowledgeCommandMenuEl)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      callbacks.onSendMessage();
    }
  });
  inputWrap.addEventListener("dragover", (event) => {
    event.preventDefault();
    inputWrap.addClass("is-dragging");
  });
  inputWrap.addEventListener("dragleave", () => inputWrap.removeClass("is-dragging"));
  inputWrap.addEventListener("drop", (event) => {
    event.preventDefault();
    inputWrap.removeClass("is-dragging");
    callbacks.onDropFiles(event);
  });

  return {
    queueEl,
    attachmentsEl,
    workspaceEl,
    inputEl,
    promptEnhanceReviewEl,
    skillMenuEl,
    knowledgeCommandMenuEl,
    toolbarEl
  };
}

export function renderPromptEnhanceReview(container: HTMLElement, callbacks: { onRestore: () => void }): void {
  container.empty();
  container.addClass("is-visible");
  const status = container.createSpan({ cls: "codex-composer-enhance-review-text", text: "已增强，可继续编辑" });
  status.createSpan({ cls: "codex-composer-enhance-review-dot", text: "·" });
  const restoreButton = container.createEl("button", {
    cls: "codex-composer-enhance-restore",
    attr: { type: "button", title: "还原", "aria-label": "还原" }
  });
  setIcon(restoreButton, "rotate-ccw");
  restoreButton.createSpan({ text: "还原" });
  restoreButton.onclick = callbacks.onRestore;
}

export function clearPromptEnhanceReview(container: HTMLElement | undefined): void {
  if (!container) return;
  container.empty();
  container.removeClass("is-visible");
}

export function renderComposerToolbar(
  container: HTMLElement,
  workspaceContainer: HTMLElement,
  state: ComposerToolbarState,
  callbacks: ComposerToolbarCallbacks
): ComposerToolbarRefs {
  container.empty();
  workspaceContainer.empty();
  workspaceContainer.toggleClass("is-visible", !state.knowledgeSession);
  if (!state.knowledgeSession) {
    addWorkspaceButton(workspaceContainer, state, callbacks);
    if (shouldShowComposerPlanIndicator(state.knowledgeSession, state.selectedMode)) {
      addPlanModeIndicator(workspaceContainer);
    }
  }

  const row = container.createDiv({ cls: "codex-composer-row" });
  const left = row.createDiv({ cls: "codex-composer-left" });
  const right = row.createDiv({ cls: "codex-composer-right" });

  const addButton = createComposerIconButton(left, "plus", "添加内容");
  addButton.onclick = callbacks.onOpenAddMenu;

  const skillButton = createComposerIconButton(left, "hammer", state.selectedSkill ? `Skill：${state.selectedSkill.name}` : "选择 Skill");
  skillButton.toggleClass("is-active", Boolean(state.selectedSkill));
  skillButton.onclick = callbacks.onOpenSkillMenu;

  const enhanceButton = createComposerIconButton(left, "sparkles", "增强提示词");
  enhanceButton.toggleClass("is-loading", state.promptEnhancerRunning);
  enhanceButton.disabled = state.promptEnhancerRunning;
  if (state.promptEnhancerRunning) {
    setIcon(enhanceButton, "loader-circle");
    enhanceButton.setAttribute("aria-busy", "true");
    enhanceButton.setAttribute("title", "正在增强提示词");
  }
  enhanceButton.onclick = callbacks.onEnhancePrompt;

  const refs: ComposerToolbarRefs = {};
  if (state.knowledgeSession) {
    const captureButton = createComposerIconButton(left, "bookmark-plus", "收藏");
    captureButton.onclick = callbacks.onCaptureKnowledgeSource;

    if (state.knowledgeBackend === "codex-cli") {
      const modelButton = addModelButton(right, "知识库模型和思考强度", state.currentKnowledgeComposerSummaryTitle, state.currentComposerModel, state.currentComposerReasoning);
      modelButton.onclick = callbacks.onOpenKnowledgeModelMenu;
    }

    const kbChip = right.createEl("button", { cls: "codex-composer-model-button codex-kb-channel-chip", attr: { type: "button", title: "知识库常用命令" } });
    kbChip.toggleClass("is-running", state.knowledgeTaskRunning);
    const kbIcon = kbChip.createSpan({ cls: "codex-composer-model-icon" });
    setIcon(kbIcon, "library");
    kbChip.createSpan({ cls: "codex-composer-model-text", text: state.knowledgeTaskRunning ? "知识库运行中" : "知识库命令" });
    const chevron = kbChip.createSpan({ cls: "codex-composer-chevron" });
    setIcon(chevron, "chevron-down");
    kbChip.onclick = callbacks.onOpenKnowledgeCommandMenu;
  } else {
    addComposerSelect<PermissionMode>(left, "shield-check", ["read-only", "workspace-write", "danger-full-access"], state.selectedPermission, callbacks.onPermissionChange, "权限", "codex-permission-control");

    refs.contextEl = right.createDiv({ cls: "codex-context-meter", attr: { title: "上下文容量" } });
    refs.contextRingEl = refs.contextEl.createSpan({ cls: "codex-context-ring", attr: { "aria-hidden": "true" } });
    refs.contextRingEl.createSpan({ cls: "codex-context-ring-hole" });
    refs.contextValueEl = refs.contextEl.createSpan({ cls: "codex-context-value", text: "--" });

    const modelButton = addModelButton(right, "模型和运行参数", state.currentComposerSummaryTitle, state.currentComposerModel, state.currentComposerReasoning);
    modelButton.onclick = callbacks.onOpenModelMenu;

    const micButton = createComposerIconButton(right, "mic", "语音输入");
    micButton.onclick = callbacks.onMicInput;
  }

  const composerState = composerStateForRuntimeState({
    viewRunning: state.running,
    viewRunKind: state.viewRunKind,
    globalKnowledgeTaskRunning: state.knowledgeTaskRunning,
    hasDraft: state.hasDraft,
    hasQueuedItems: state.hasQueuedItems
  });
  const action = composerPrimaryActionForState(composerState);
  const sendButtonView = composerActionButtonView(action);
  const sendButton = row.createEl("button", {
    cls: "codex-send-button codex-composer-send-button",
    attr: { type: "button", "aria-label": sendButtonView.label, title: sendButtonView.title }
  });
  sendButton.toggleClass("is-queue-action", action === "enqueue" || action === "resume-queue");
  sendButton.disabled = state.promptEnhancerRunning;
  if (state.promptEnhancerRunning) {
    sendButton.setAttribute("aria-label", "提示词增强中");
    sendButton.setAttribute("title", "提示词增强完成后再发送");
  }
  setIcon(sendButton, sendButtonView.icon);
  sendButton.onclick = () => {
    if (action === "cancel-knowledge-task") callbacks.onCancelKnowledgeTask();
    else if (action === "stop-turn") callbacks.onStopTurn();
    else if (action === "enqueue") callbacks.onEnqueueDraft();
    else if (action === "resume-queue") callbacks.onResumeQueue(state.session.id);
    else callbacks.onSendMessage();
  };
  return refs;
}

export function renderTurnQueue(container: HTMLElement, state: TurnQueueState, callbacks: TurnQueueCallbacks): void {
  container.empty();
  container.toggleClass("is-visible", Boolean(state.items.length));
  container.toggleClass("is-paused", state.paused);
  if (!state.items.length) return;

  const header = container.createDiv({ cls: "codex-turn-queue-header" });
  const title = header.createDiv({ cls: "codex-turn-queue-title" });
  const titleIcon = title.createSpan({ cls: "codex-turn-queue-title-icon" });
  setIcon(titleIcon, state.paused ? "pause-circle" : "list-ordered");
  title.createSpan({ text: state.paused ? `队列已暂停 · ${state.items.length}` : `队列 · ${state.items.length}` });

  if (state.canResume) {
    const resume = header.createEl("button", {
      cls: "codex-turn-queue-resume",
      attr: { type: "button", title: "继续队列", "aria-label": "继续队列" }
    });
    setIcon(resume, "play");
    resume.onclick = callbacks.onResume;
  }

  const list = container.createDiv({ cls: "codex-turn-queue-list" });
  state.items.forEach((item, index) => renderQueuedTurnItem(list, item, index, state, callbacks));
}

export function renderComposerAttachments(container: HTMLElement, state: ComposerAttachmentsState, callbacks: ComposerAttachmentsCallbacks): void {
  container.empty();
  container.toggleClass("is-empty", !state.selectedSkill && state.attachments.length === 0);
  if (state.selectedSkill) {
    const chip = container.createDiv({ cls: "codex-skill-token" });
    const icon = chip.createSpan({ cls: "codex-skill-token-icon" });
    setIcon(icon, "box");
    chip.createSpan({ cls: "codex-skill-token-name", text: state.selectedSkill.name });
    const remove = chip.createEl("button", { attr: { type: "button", "aria-label": `移除 Skill：${state.selectedSkill.name}`, title: "移除 Skill" } });
    setIcon(remove, "x");
    remove.onclick = callbacks.onRemoveSkill;
  }
  for (const item of state.attachments) {
    const chip = container.createDiv({ cls: "codex-attachment-chip" });
    chip.createSpan({ text: item.name });
    const remove = chip.createEl("button", { text: "×", attr: { type: "button" } });
    remove.onclick = () => callbacks.onRemoveAttachment(item.path);
  }
}

export function labelFor(value: string): string {
  const labels: Record<string, string> = {
    low: "低思考",
    medium: "中思考",
    high: "高思考",
    xhigh: "超高思考",
    standard: "标准",
    fast: "快速",
    flex: "弹性",
    "read-only": "只读",
    "workspace-write": "工作区可写",
    "danger-full-access": "完全访问权限",
    agent: "Agent",
    plan: "Plan"
  };
  return labels[value] ?? value;
}

export function compactReasoningLabel(value: ReasoningEffort): string {
  const labels: Record<string, string> = {
    none: "无",
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高"
  };
  return labels[value] ?? value;
}

export function shortModelLabel(value: string): string {
  if (!value.trim()) return "自动";
  return value
    .replace(/^gpt-/i, "")
    .replace(/-/g, " ")
    .replace(/\bmini\b/i, "Mini")
    .replace(/\bhigh\b/i, "High")
    .trim();
}

function renderQueuedTurnItem(container: HTMLElement, item: QueuedTurnItem, index: number, state: TurnQueueState, callbacks: TurnQueueCallbacks): void {
  const row = container.createDiv({ cls: "codex-turn-queue-item", attr: { draggable: "true" } });
  row.dataset.queueItemId = item.id;
  const handle = row.createSpan({ cls: "codex-turn-queue-handle", attr: { "aria-hidden": "true" } });
  setIcon(handle, "grip-vertical");
  row.ondragstart = (event) => {
    event.stopPropagation();
    callbacks.onDragStart(item.id);
    event.dataTransfer?.setData("text/plain", item.id);
    event.dataTransfer?.setDragImage(row, 12, 12);
  };
  row.ondragend = callbacks.onDragEnd;
  row.ondragover = (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.addClass("is-drag-over");
  };
  row.ondragleave = (event) => {
    event.stopPropagation();
    row.removeClass("is-drag-over");
  };
  row.ondrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.removeClass("is-drag-over");
    const sourceId = event.dataTransfer?.getData("text/plain") || state.draggedItemId;
    if (!sourceId || sourceId === item.id) return;
    callbacks.onReorder(item.sessionId, sourceId, index);
  };

  const body = row.createDiv({ cls: "codex-turn-queue-body" });
  body.createDiv({ cls: "codex-turn-queue-preview", text: queuedTurnPreview(item) });
  body.createDiv({ cls: "codex-turn-queue-meta", text: queuedTurnMeta(item) });

  const remove = row.createEl("button", {
    cls: "codex-turn-queue-remove",
    attr: { type: "button", title: "删除队列项", "aria-label": "删除队列项" }
  });
  setIcon(remove, "x");
  remove.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    callbacks.onRemove(item.sessionId, item.id);
  };
}

function createComposerIconButton(container: HTMLElement, iconName: string, title: string): HTMLButtonElement {
  const button = container.createEl("button", {
    cls: "codex-composer-icon-button",
    attr: { type: "button", "aria-label": title, title }
  });
  setIcon(button, iconName);
  return button;
}

function addModelButton(container: HTMLElement, ariaLabel: string, title: string, model: string, reasoning: string): HTMLButtonElement {
  const modelButton = container.createEl("button", {
    cls: "codex-composer-model-button codex-model-summary-button",
    attr: { type: "button", "aria-label": ariaLabel, "aria-haspopup": "menu", "aria-expanded": "false", title }
  });
  modelButton.createSpan({ cls: "codex-composer-model-name", text: model });
  modelButton.createSpan({ cls: "codex-composer-reasoning-label", text: reasoning });
  const chevron = modelButton.createSpan({ cls: "codex-composer-chevron" });
  setIcon(chevron, "chevron-down");
  return modelButton;
}

function addComposerSelect<T extends string>(
  container: HTMLElement,
  iconName: string,
  values: T[],
  selected: T,
  onChange: (value: T) => void,
  label: string,
  extraClass = ""
): void {
  const control = container.createDiv({ cls: `codex-composer-select ${extraClass}`.trim(), attr: { title: label } });
  control.toggleClass("is-danger", selected === "danger-full-access");
  const icon = control.createSpan({ cls: "codex-composer-select-icon" });
  setIcon(icon, iconName);
  const select = control.createEl("select", { cls: "codex-select codex-composer-native-select", attr: { "aria-label": label, title: label } });
  for (const value of values) select.createEl("option", { text: labelFor(value), value });
  select.value = selected;
  select.onchange = () => onChange(select.value as T);
}

function addWorkspaceButton(container: HTMLElement, state: ComposerToolbarState, callbacks: ComposerToolbarCallbacks): void {
  const title = state.workspacePath
    ? `工作区：${state.workspacePath}${state.workspaceValid ? "" : "\n文件夹不存在，请重新选择"}`
    : "选择文件夹作为本会话工作区";
  const button = container.createEl("button", {
    cls: "codex-composer-model-button codex-workspace-button",
    attr: { type: "button", title, "aria-label": "选择工作区", "aria-haspopup": "menu" }
  });
  button.toggleClass("has-workspace", Boolean(state.workspacePath));
  button.toggleClass("is-invalid", Boolean(state.workspacePath && !state.workspaceValid));
  const icon = button.createSpan({ cls: "codex-composer-model-icon" });
  setIcon(icon, state.workspacePath ? "folder-open" : "folder");
  button.createSpan({ cls: "codex-composer-model-text", text: state.workspacePath ? state.workspaceDisplayName : "请选择文件夹" });
  const chevron = button.createSpan({ cls: "codex-composer-chevron" });
  setIcon(chevron, "chevron-down");
  button.onclick = (event) => callbacks.onOpenWorkspaceMenu(event, state.session);
}

function addPlanModeIndicator(container: HTMLElement): void {
  const indicator = container.createDiv({
    cls: "codex-composer-mode-indicator",
    attr: { "aria-label": "当前模式：计划", title: "当前模式：计划" }
  });
  const icon = indicator.createSpan({ cls: "codex-composer-mode-indicator-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, "list-todo");
  indicator.createSpan({ cls: "codex-composer-mode-indicator-label", text: "计划" });
}

function composerActionButtonView(action: ReturnType<typeof composerPrimaryActionForState>): { icon: string; label: string; title: string } {
  if (action === "enqueue") return { icon: "list-plus", label: "入队发送", title: "加入队列，当前任务结束后发送" };
  if (action === "resume-queue") return { icon: "play", label: "继续队列", title: "继续队列" };
  if (action === "stop-turn" || action === "cancel-knowledge-task") return { icon: "square", label: "停止", title: "停止当前任务" };
  return { icon: "send-horizontal", label: "发送", title: "发送" };
}

function queuedTurnPreview(item: QueuedTurnItem): string {
  const text = item.text.trim() || (item.attachments.length ? "(附件)" : "");
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function queuedTurnMeta(item: QueuedTurnItem): string {
  const parts = [
    item.kind === "knowledge-base" ? "知识库" : "对话",
    item.turnOptions.model ? shortModelLabel(item.turnOptions.model) : "自动",
    compactReasoningLabel(item.turnOptions.reasoning)
  ];
  if (item.skill) parts.push(`Skill ${item.skill.name}`);
  if (item.attachments.length) parts.push(`${item.attachments.length} 个附件`);
  return parts.join(" · ");
}
