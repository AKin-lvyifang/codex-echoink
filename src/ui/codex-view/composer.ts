import { setIcon } from "obsidian";
import {
  renderProviderBrandIcon,
  type ProviderBrandId
} from "../../settings/provider-brand-icons";
import type { EchoInkResource } from "../../resources/types";
import { enabledSkillResources } from "../../resources/registry";
import { resourcePresentation } from "../../resources/resource-presentation";
import { mcpConnectionStatus, mcpConnectionStatusLabel } from "../../resources/mcp-connections";
import type { EchoInkResourceSettings } from "../../resources/types";
import type {
  PiConversationDiagnostic,
  PiConversationSupportState
} from "../../harness/pi-native/contracts";
import type { PiContextLedger } from "../../harness/pi-native/pi-context-budget";
import { formatContextTokenCount } from "../../core/mapping";
import type {
  SettingsLanguage,
  StoredAttachment,
  StoredSession
} from "../../settings/settings";
import type { PermissionMode, ReasoningEffort, UiMode } from "../../types/app-server";
import { composerPrimaryActionForState, composerStateForRuntimeState } from "../composer-state";
import { handleKnowledgeCommandMenuKeyDown } from "../knowledge-command-menu";
import type { QueuedTurnItem } from "../turn-queue";
import { renderAnimateIcon } from "../animate-icon";
import type { EchoInkAttachmentResourceResolver } from "./attachment-resource";
import { renderFileCard } from "./file-card";
import {
  markAIElementsAttachmentItem,
  markAIElementsAttachments
} from "./smooth-chat-ui";
import {
  handleComposerNoteMentionKeyDown,
  reconcileComposerNoteMentionMenuAtCursor,
  type NoteMentionCatalogEntry,
  type NoteMentionSelection
} from "./note-mentions";
import { conversationUiText } from "./ui-i18n";

let knowledgeCommandMenuId = 0;

export interface ComposerShellRefs {
  queueEl: HTMLElement;
  attachmentsEl: HTMLElement;
  workspaceEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  promptEnhanceReviewEl: HTMLElement;
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
  noteMentionMenuEl: HTMLElement;
  resourcePanelEl: HTMLElement;
  toolbarEl: HTMLElement;
}

export interface ComposerShellCallbacks {
  onInputChanged: () => void;
  onPasteFiles: (event: ClipboardEvent) => void;
  onSendMessage: () => void;
  onDropFiles: (event: DragEvent) => void;
}

export interface ComposerToolbarState {
  language?: SettingsLanguage;
  session: StoredSession;
  knowledgeTaskRunning: boolean;
  selectedSkill: EchoInkResource | null;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  running: boolean;
  promptEnhancerRunning: boolean;
  viewRunKind?: "chat" | "editor" | "";
  activeRunSessionId?: string;
  hasDraft: boolean;
  hasTextDraft: boolean;
  hasQueuedItems: boolean;
  currentComposerModel: string;
  currentComposerProviderBrand: ProviderBrandId;
  currentComposerSummaryTitle: string;
  workspacePath: string;
  workspaceDisplayName: string;
  workspaceValid: boolean;
  contextLedger?: Readonly<PiContextLedger>;
  contextPanelOpen: boolean;
}

export interface ComposerToolbarRefs {
  addButtonEl?: HTMLButtonElement;
  contextEl?: HTMLElement;
  contextRingEl?: HTMLElement;
}

export interface ComposerResourcePanelState {
  open: boolean;
  selectedSkill: EchoInkResource | null;
  selectedMode: UiMode;
  resources: EchoInkResource[];
  resourceSettings: Pick<EchoInkResourceSettings, "mcpConnections">;
  language: "zh-CN" | "en";
  canAttachActiveFile: boolean;
}

export interface ComposerResourcePanelCallbacks {
  onDismiss: (restoreFocus: boolean) => void;
  onPickFiles: (imagesOnly: boolean) => void;
  onAttachActiveFile: () => void;
  onSelectPlanMode: () => void;
  onSelectSkill: (skill: EchoInkResource) => void;
  onOpenMcpSettings: () => void;
}

export interface ComposerToolbarCallbacks {
  onOpenAddMenu: (event: MouseEvent) => void;
  onEnhancePrompt: () => void;
  onCaptureKnowledgeSource: () => void;
  onPermissionChange: (value: PermissionMode) => void;
  onOpenWorkspaceMenu: (event: MouseEvent, session: StoredSession) => void;
  onOpenModelMenu: (event: MouseEvent) => void;
  onToggleContextPanel: () => void;
  onMicInput: () => void;
  onCancelKnowledgeTask: () => void;
  onStopTurn: () => void;
  onSteerPiChat: () => void;
  onEnqueueDraft: () => void;
  onResumeQueue: (sessionId: string) => void;
  onSendMessage: () => void;
}

export interface TurnQueueState {
  language?: SettingsLanguage;
  items: QueuedTurnItem[];
  paused: boolean;
  canResume: boolean;
  recoveryRequired: boolean;
  canRecover: boolean;
  draggedItemId: string;
  piSupport: PiConversationSupportState | null;
  piRecoveryPending: boolean;
  canManagePiSupport: boolean;
}

export interface TurnQueueCallbacks {
  onResume: () => void;
  onRecover: () => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onReorder: (sessionId: string, sourceId: string, targetIndex: number) => void;
  onRemove: (sessionId: string, itemId: string) => void;
  onEditPiDraft: (draftId: string) => void;
  onRemovePiDraft: (draftId: string) => void;
  onRecoverPiConversation: (recoveryPath: string) => void;
}

export interface ComposerAttachmentsState {
  language?: SettingsLanguage;
  selectedSkill: EchoInkResource | null;
  noteMentions: readonly Readonly<NoteMentionSelection>[];
  attachments: StoredAttachment[];
  attachmentResolver: EchoInkAttachmentResourceResolver;
}

export interface ComposerAttachmentsCallbacks {
  onRemoveSkill: () => void;
  onRemoveNoteMention: (vaultRelativePath: string) => void;
  onRemoveAttachment: (path: string) => void;
  onOpenAttachment: (attachment: Readonly<StoredAttachment>) => void;
}

export function shouldShowComposerPlanIndicator(selectedMode: UiMode): boolean {
  return selectedMode === "plan";
}

export function renderComposerShell(
  rootEl: HTMLElement,
  callbacks: ComposerShellCallbacks,
  language: SettingsLanguage = "zh-CN"
): ComposerShellRefs {
  const inputWrap = rootEl.createDiv({ cls: "codex-input-wrap" });
  const queueEl = inputWrap.createDiv({ cls: "codex-turn-queue" });
  const workspaceEl = inputWrap.createDiv({ cls: "codex-composer-workspace" });
  const attachmentsEl = inputWrap.createDiv({ cls: "codex-attachments" });
  const commandMenuId = `codex-knowledge-command-menu-${++knowledgeCommandMenuId}`;
  const inputEl = inputWrap.createEl("textarea", {
    cls: "codex-input",
    attr: {
      placeholder: "",
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": commandMenuId,
      "aria-label": conversationUiText(language, "输入消息、命令或已启用 Skill", "Enter a message, command, or enabled Skill")
    }
  });
  const promptEnhanceReviewEl = inputWrap.createDiv({ cls: "codex-composer-enhance-review" });
  const skillMenuEl = inputWrap.createDiv({ cls: "codex-skill-menu" });
  const knowledgeCommandMenuEl = inputWrap.createDiv({
    cls: "codex-knowledge-command-menu",
    attr: {
      id: commandMenuId,
      role: "listbox",
      "aria-label": conversationUiText(language, "命令与已启用 Skill", "Commands and enabled Skills")
    }
  });
  const resourcePanelEl = inputWrap.createDiv({
    cls: "codex-composer-resource-panel",
    attr: {
      role: "menu",
      "aria-label": conversationUiText(language, "添加资源", "Add resources"),
      "aria-hidden": "true"
    }
  });
  const noteMentionMenuId = `${commandMenuId}-note-mentions`;
  const noteMentionMenuEl = inputWrap.createDiv({
    cls: "codex-composer-resource-panel codex-note-mention-menu",
    attr: {
      id: noteMentionMenuId,
      role: "listbox",
      "aria-label": conversationUiText(language, "提及笔记", "Mention notes"),
      "aria-hidden": "true"
    }
  });
  const toolbarEl = inputWrap.createDiv({ cls: "codex-toolbar" });
  inputEl.addEventListener("input", callbacks.onInputChanged);
  inputEl.addEventListener("selectionchange", () => {
    reconcileComposerNoteMentionMenuAtCursor(inputEl);
  });
  inputEl.addEventListener("paste", callbacks.onPasteFiles);
  inputEl.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (handleComposerNoteMentionKeyDown(event, inputEl)) return;
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
    noteMentionMenuEl,
    resourcePanelEl,
    toolbarEl
  };
}

/** Refreshes only persistent Composer chrome; draft text and attachments stay untouched. */
export function refreshComposerShellCopy(rootEl: HTMLElement, language: SettingsLanguage): void {
  rootEl.querySelector<HTMLTextAreaElement>(".codex-input")?.setAttribute(
    "aria-label",
    conversationUiText(language, "输入消息、命令或已启用 Skill", "Enter a message, command, or enabled Skill")
  );
  rootEl.querySelector<HTMLElement>(".codex-knowledge-command-menu")?.setAttribute(
    "aria-label",
    conversationUiText(language, "命令与已启用 Skill", "Commands and enabled Skills")
  );
  rootEl.querySelector<HTMLElement>(".codex-composer-resource-panel:not(.codex-note-mention-menu)")?.setAttribute(
    "aria-label",
    conversationUiText(language, "添加资源", "Add resources")
  );
  rootEl.querySelector<HTMLElement>(".codex-note-mention-menu")?.setAttribute(
    "aria-label",
    conversationUiText(language, "提及笔记", "Mention notes")
  );
}

export function renderComposerNoteMentionMenu(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  state: Readonly<{
    open: boolean;
    results: readonly Readonly<NoteMentionCatalogEntry>[];
    activeIndex: number;
    loading?: boolean;
  }>,
  callbacks: Readonly<{
    onSelect: (entry: Readonly<NoteMentionCatalogEntry>) => void;
  }>,
  language: SettingsLanguage = "zh-CN"
): void {
  container.empty();
  container.toggleClass("is-visible", state.open);
  container.setAttribute("aria-hidden", String(!state.open));
  if (!state.open) return;
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", container.id);
  if (state.loading) {
    input.removeAttribute("aria-activedescendant");
    container.createDiv({
      cls: "codex-note-mention-empty",
      text: conversationUiText(language, "正在读取笔记…", "Loading notes…")
    });
    return;
  }
  if (!state.results.length) {
    input.removeAttribute("aria-activedescendant");
    container.createDiv({
      cls: "codex-note-mention-empty",
      text: conversationUiText(language, "没有匹配的笔记", "No matching notes")
    });
    return;
  }
  for (const [index, entry] of state.results.entries()) {
    const optionId = `${container.id}-option-${index}`;
    const row = container.createEl("button", {
      cls: `codex-composer-resource-row codex-note-mention-option${index === state.activeIndex ? " is-active" : ""}`,
      attr: {
        id: optionId,
        type: "button",
        role: "option",
        tabindex: "-1",
        "aria-selected": String(index === state.activeIndex),
        title: entry.fileName
      }
    });
    const icon = row.createSpan({
      cls: "codex-composer-resource-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(icon, "file-text");
    row.createSpan({ cls: "codex-composer-resource-name", text: entry.fileName });
    row.onpointerdown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      callbacks.onSelect(entry);
    };
    if (index === state.activeIndex) input.setAttribute("aria-activedescendant", optionId);
  }
}

export function renderPromptEnhanceReview(
  container: HTMLElement,
  callbacks: { onRestore: () => void },
  language: SettingsLanguage = "zh-CN"
): void {
  container.empty();
  container.addClass("is-visible");
  const status = container.createSpan({
    cls: "codex-composer-enhance-review-text",
    text: conversationUiText(language, "已增强，可继续编辑", "Enhanced — continue editing")
  });
  status.createSpan({ cls: "codex-composer-enhance-review-dot", text: "·" });
  const restoreButton = container.createEl("button", {
    cls: "codex-composer-enhance-restore",
    attr: {
      type: "button",
      title: conversationUiText(language, "还原", "Restore"),
      "aria-label": conversationUiText(language, "还原", "Restore")
    }
  });
  setIcon(restoreButton, "rotate-ccw");
  restoreButton.createSpan({ text: conversationUiText(language, "还原", "Restore") });
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
  const language = state.language ?? "zh-CN";
  container.empty();
  workspaceContainer.empty();
  workspaceContainer.addClass("is-visible");
  addWorkspaceButton(workspaceContainer, state, callbacks, language);
  if (shouldShowComposerPlanIndicator(state.selectedMode)) {
    addPlanModeIndicator(workspaceContainer, language);
  }

  const row = container.createDiv({ cls: "codex-composer-row" });
  const left = row.createDiv({ cls: "codex-composer-left" });
  const right = row.createDiv({ cls: "codex-composer-right" });

  const addButton = createComposerIconButton(left, "plus", conversationUiText(language, "添加资源", "Add resources"));
  addButton.setAttribute("aria-haspopup", "menu");
  addButton.setAttribute("aria-expanded", "false");
  addButton.dataset.composerAddButton = "true";
  addButton.onclick = callbacks.onOpenAddMenu;

  const refs: ComposerToolbarRefs = { addButtonEl: addButton };
  const captureButton = createComposerIconButton(left, "bookmark-plus", conversationUiText(language, "收藏到知识库", "Save to Knowledge"));
  captureButton.onclick = callbacks.onCaptureKnowledgeSource;

  addComposerSelect<PermissionMode>(
    left,
    "shield-check",
    ["read-only", "workspace-write", "danger-full-access"],
    state.selectedPermission,
    callbacks.onPermissionChange,
    conversationUiText(language, "权限", "Access"),
    language,
    "codex-permission-control"
  );
  refs.contextEl = right.createEl("button", {
    cls: "codex-context-meter",
    attr: {
      type: "button",
      title: conversationUiText(language, "查看最近一次模型请求的上下文用量", "View context usage for the latest model request"),
      "aria-label": conversationUiText(language, "查看上下文用量", "View context usage"),
      "aria-expanded": state.contextPanelOpen ? "true" : "false",
      "aria-haspopup": "dialog"
    }
  });
  refs.contextRingEl = refs.contextEl.createSpan({ cls: "codex-context-ring", attr: { "aria-hidden": "true" } });
  refs.contextRingEl.createSpan({ cls: "codex-context-ring-hole" });
  refs.contextEl.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    callbacks.onToggleContextPanel();
  };

  const modelButton = addModelButton(
    right,
    conversationUiText(language, "模型和运行参数", "Model and run settings"),
    state.currentComposerSummaryTitle,
    state.currentComposerModel,
    state.currentComposerProviderBrand,
    language
  );
  modelButton.onclick = callbacks.onOpenModelMenu;

  const micButton = right.createEl("button", {
    cls: "codex-composer-icon-button codex-composer-mic-button",
    attr: {
      type: "button",
      "aria-label": conversationUiText(language, "语音输入", "Voice input"),
      title: conversationUiText(language, "语音输入", "Voice input")
    }
  });
  renderAnimateIcon(micButton, "mic");
  micButton.onclick = callbacks.onMicInput;

  const composerState = composerStateForRuntimeState({
    viewRunning: state.running,
    viewRunKind: state.viewRunKind,
    globalKnowledgeTaskRunning: state.knowledgeTaskRunning,
    hasDraft: state.hasDraft,
    hasQueuedItems: state.hasQueuedItems
  });
  const action = composerPrimaryActionForState(composerState);
  if (shouldShowPiSteerAction(state)) {
    const steerButton = row.createEl("button", {
      cls: "codex-composer-steer-button",
      attr: {
        type: "button",
        title: conversationUiText(language, "立即调整当前 Pi 任务方向", "Steer the current Pi task now"),
        "aria-label": conversationUiText(language, "调整方向", "Steer task")
      }
    });
    const steerIcon = steerButton.createSpan({
      cls: "codex-composer-steer-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(steerIcon, "git-branch");
    steerButton.createSpan({
      cls: "codex-composer-steer-label",
      text: conversationUiText(language, "调整方向", "Steer task")
    });
    steerButton.onclick = callbacks.onSteerPiChat;
  }
  const sendButtonView = composerActionButtonView(action, language);
  const sendButton = row.createEl("button", {
    cls: "codex-send-button codex-composer-send-button",
    attr: { type: "button", "aria-label": sendButtonView.label, title: sendButtonView.title }
  });
  sendButton.toggleClass("is-send-action", action === "send");
  sendButton.toggleClass("is-queue-action", action === "enqueue" || action === "resume-queue");
  sendButton.toggleClass("is-stop-action", action === "stop-turn" || action === "cancel-knowledge-task");
  const anotherConversationOwnsStop = action === "stop-turn"
    && Boolean(state.activeRunSessionId)
    && state.activeRunSessionId !== state.session.id;
  sendButton.disabled = state.promptEnhancerRunning || anotherConversationOwnsStop;
  if (state.promptEnhancerRunning) {
    sendButton.setAttribute("aria-label", conversationUiText(language, "提示词增强中", "Enhancing prompt"));
    sendButton.setAttribute("title", conversationUiText(language, "提示词增强完成后再发送", "Send after prompt enhancement finishes"));
  } else if (anotherConversationOwnsStop) {
    sendButton.setAttribute("aria-label", conversationUiText(language, "另一个会话正在运行", "Another conversation is running"));
    sendButton.setAttribute("title", conversationUiText(language, "切回运行中的会话后可停止", "Switch to the running conversation to stop it"));
  }
  if (action === "send") {
    renderAnimateIcon(sendButton, "send-horizontal");
  } else if (action === "stop-turn" || action === "cancel-knowledge-task") {
    renderAnimateIcon(sendButton, "circle-stop");
  } else {
    const sendIconWrap = sendButton.createSpan({
      cls: "codex-composer-send-icon-wrap",
      attr: { "aria-hidden": "true" }
    });
    setIcon(sendIconWrap, sendButtonView.icon);
  }
  sendButton.onclick = () => {
    if (action === "cancel-knowledge-task") callbacks.onCancelKnowledgeTask();
    else if (action === "stop-turn") callbacks.onStopTurn();
    else if (action === "enqueue") callbacks.onEnqueueDraft();
    else if (action === "resume-queue") callbacks.onResumeQueue(state.session.id);
    else callbacks.onSendMessage();
  };
  return refs;
}

export function renderComposerResourcePanel(
  container: HTMLElement,
  state: ComposerResourcePanelState,
  callbacks: ComposerResourcePanelCallbacks
): void {
  container.empty();
  container.toggleClass("is-visible", state.open);
  container.setAttribute("aria-hidden", String(!state.open));
  if (!state.open) return;

  const copy = (zh: string, en: string) => conversationUiText(state.language, zh, en);
  const addGroup = createResourcePanelGroup(container, copy("添加", "Add"));
  createResourcePanelRow(addGroup, "paperclip", copy("文件和文件夹", "Files and folders"), "", () => callbacks.onPickFiles(false));
  createResourcePanelRow(
    addGroup,
    "file-text",
    copy("添加当前笔记", "Add current note"),
    state.canAttachActiveFile ? "" : copy("没有当前显示的 Markdown 笔记", "No Markdown note is currently open"),
    callbacks.onAttachActiveFile,
    false,
    "",
    !state.canAttachActiveFile
  );
  createResourcePanelRow(
    addGroup,
    "lightbulb",
    copy("计划模式", "Plan mode"),
    state.selectedMode === "plan" ? copy("已开启", "On") : "",
    callbacks.onSelectPlanMode,
    state.selectedMode === "plan"
  );
  createResourcePanelRow(addGroup, "image", copy("添加图片", "Add image"), "", () => callbacks.onPickFiles(true));

  const skillGroup = createResourcePanelGroup(container, copy("技能", "Skills"));
  const skills = enabledSkillResources(state.resources);
  if (skills.length) {
    for (const skill of skills) {
      const presentation = resourcePresentation(skill, state.language ?? "zh-CN");
      createResourcePanelRow(
        skillGroup,
        "box",
        presentation.name,
        presentation.description || skill.contentPath || copy("已启用 Skill", "Enabled Skill"),
        () => callbacks.onSelectSkill(skill),
        state.selectedSkill?.id === skill.id
      );
    }
  } else {
    skillGroup.createDiv({ cls: "codex-composer-resource-empty", text: copy("暂无已启用 Skill", "No enabled Skills") });
  }

  const mcpGroup = createResourcePanelGroup(container, "MCP");
  const mcpResources = state.resources
    .filter((resource) => resource.kind === "mcp-server")
    .sort((left, right) => left.name.localeCompare(right.name, state.language === "en" ? "en" : "zh-CN"));
  if (mcpResources.length) {
    for (const resource of mcpResources) {
      const status = mcpConnectionStatus(resource, state.resourceSettings);
      createResourcePanelRow(
        mcpGroup,
        "blocks",
        resource.name,
        mcpConnectionStatusLabel(status, state.language),
        callbacks.onOpenMcpSettings,
        resource.enabled,
        `is-mcp-status-${status}`
      );
    }
  } else {
    mcpGroup.createDiv({ cls: "codex-composer-resource-empty", text: copy("暂无已配置 MCP", "No configured MCP servers") });
  }

  container.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      callbacks.onDismiss(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".codex-composer-resource-row")
    ).filter((row) => !row.disabled);
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(container.ownerDocument.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : event.key === "ArrowDown"
          ? (current + 1 + rows.length) % rows.length
          : (current - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  };
}

function createResourcePanelGroup(container: HTMLElement, label: string): HTMLElement {
  const group = container.createDiv({ cls: "codex-composer-resource-group", attr: { role: "group", "aria-label": label } });
  group.createDiv({ cls: "codex-composer-resource-group-label", text: label });
  return group;
}

function createResourcePanelRow(
  container: HTMLElement,
  iconName: string,
  label: string,
  description: string,
  onActivate: () => void,
  active = false,
  extraClass = "",
  disabled = false
): HTMLButtonElement {
  const row = container.createEl("button", {
    cls: `codex-composer-resource-row${active ? " is-active" : ""}${extraClass ? ` ${extraClass}` : ""}`,
    attr: { type: "button", role: "menuitem" }
  });
  row.disabled = disabled;
  const icon = row.createSpan({ cls: "codex-composer-resource-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, iconName);
  row.createSpan({ cls: "codex-composer-resource-name", text: label });
  if (description) row.createSpan({ cls: "codex-composer-resource-description", text: description });
  row.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  };
  return row;
}

const CONTEXT_CATEGORY_LABELS: Readonly<Record<
  PiContextLedger["categories"][number]["category"],
  string
>> = Object.freeze({
  system: "系统提示词",
  vault_tool_schema: "Obsidian 工具",
  mcp_tool_schema: "连接器及 MCP",
  skill: "技能",
  conversation: "对话消息",
  compaction: "上下文摘要",
  memory: "长期记忆",
  knowledge: "知识库",
  temporary_materials: "临时材料"
});

export function contextCategoryLabel(
  category: PiContextLedger["categories"][number]["category"],
  language: SettingsLanguage = "zh-CN"
): string {
  if (language !== "en") return CONTEXT_CATEGORY_LABELS[category];
  return ({
    system: "System prompt",
    vault_tool_schema: "Obsidian tools",
    mcp_tool_schema: "Connectors and MCP",
    skill: "Skills",
    conversation: "Conversation messages",
    compaction: "Context summary",
    memory: "Long-term memory",
    knowledge: "Knowledge",
    temporary_materials: "Temporary materials"
  } as Record<PiContextLedger["categories"][number]["category"], string>)[category];
}

export function renderContextPanel(
  container: HTMLElement,
  ledger: Readonly<PiContextLedger> | undefined,
  onClose: () => void,
  language: SettingsLanguage = "zh-CN"
): void {
  const copy = (zh: string, en: string) => conversationUiText(language, zh, en);
  container.empty();
  const header = container.createDiv({ cls: "codex-context-panel-header" });
  header.createDiv({ cls: "codex-context-panel-title", text: copy("上下文用量", "Context usage") });
  const closeButton = header.createEl("button", {
    cls: "codex-context-panel-close",
    attr: {
      type: "button",
      title: copy("关闭", "Close"),
      "aria-label": copy("关闭上下文用量", "Close context usage")
    }
  });
  setIcon(closeButton, "x");
  closeButton.onclick = onClose;
  if (!ledger) {
    container.createDiv({
      cls: "codex-context-panel-empty",
      text: copy("发送一条消息后，这里会显示最近一次模型请求的真实上下文用量。", "After you send a message, this shows the actual context usage for the latest model request.")
    });
    return;
  }

  const percent = ledger.budget.effectiveInputBudget > 0
    ? Math.min(100, (ledger.totalInputTokens / ledger.budget.effectiveInputBudget) * 100)
    : 0;
  const summary = container.createDiv({ cls: "codex-context-summary" });
  summary.createEl("strong", {
    cls: "codex-context-summary-percent",
    text: `${Math.round(percent * 10) / 10}%`
  });
  summary.createSpan({
    cls: "codex-context-summary-used",
    text: language === "en"
      ? `Used ${formatContextTokenCount(ledger.totalInputTokens)} / ${formatContextTokenCount(ledger.budget.effectiveInputBudget)}`
      : `已用 ${formatContextTokenCount(ledger.totalInputTokens)} / ${formatContextTokenCount(ledger.budget.effectiveInputBudget)}`
  });
  const progress = container.createDiv({
    cls: "codex-context-progress",
    attr: {
      role: "progressbar",
      "aria-label": copy("有效输入预算使用率", "Effective input budget usage"),
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(percent))
    }
  });
  const usedBar = progress.createDiv({ cls: "codex-context-progress-used", attr: { "aria-hidden": "true" } });
  usedBar.setCssProps({
    "--codex-context-progress": `${percent}%`
  });
  const categoryTotal = ledger.categories.reduce((total, category) => total + category.tokens, 0);
  for (const category of ledger.categories) {
    if (category.tokens <= 0 || categoryTotal <= 0) continue;
    usedBar.createDiv({
      cls: `codex-context-progress-segment is-${category.category}`
    }).setCssProps({
      "--codex-context-segment": `${(category.tokens / categoryTotal) * 100}%`
    });
  }

  const categories = container.createDiv({ cls: "codex-context-categories" });
  for (const category of ledger.categories) {
    const row = categories.createDiv({ cls: "codex-context-category" });
    const label = row.createSpan({ cls: "codex-context-category-label" });
    label.createSpan({
      cls: `codex-context-category-dot is-${category.category}`,
      attr: { "aria-hidden": "true" }
    });
    label.createSpan({ text: contextCategoryLabel(category.category, language) });
    row.createSpan({
      cls: "codex-context-category-value",
      text: `${ledger.budget.effectiveInputBudget > 0
        ? Math.round((category.tokens / ledger.budget.effectiveInputBudget) * 1000) / 10
        : 0}%`
    });
  }
}

export function shouldShowPiSteerAction(
  state: Pick<
    ComposerToolbarState,
    | "session"
    | "running"
    | "promptEnhancerRunning"
    | "viewRunKind"
    | "activeRunSessionId"
    | "hasTextDraft"
  >
): boolean {
  return Boolean(
    state.session.bodyAuthority === "pi_session_only"
    && state.running
    && !state.promptEnhancerRunning
    && state.viewRunKind === "chat"
    && state.activeRunSessionId === state.session.id
    && state.hasTextDraft
  );
}

export function renderTurnQueue(container: HTMLElement, state: TurnQueueState, callbacks: TurnQueueCallbacks): void {
  const language = state.language ?? "zh-CN";
  container.empty();
  const visibleDiagnostics = visiblePiConversationDiagnostics(state.piSupport);
  const recovery = piConversationRecoveryCandidate(state.piSupport);
  const piDrafts = state.piSupport?.drafts ?? [];
  const hasLegacyQueue = Boolean(state.items.length) || state.recoveryRequired;
  container.toggleClass(
    "is-visible",
    hasLegacyQueue || Boolean(piDrafts.length) || Boolean(visibleDiagnostics.length)
  );
  container.toggleClass("is-paused", state.paused);
  container.toggleClass("is-recovery-required", state.recoveryRequired);
  if (!hasLegacyQueue && !piDrafts.length && !visibleDiagnostics.length) return;

  if (visibleDiagnostics.length) {
    renderPiConversationDiagnostics(
      container,
      visibleDiagnostics,
      recovery,
      state,
      callbacks,
      language
    );
  }

  if (piDrafts.length) {
    renderPiConversationDrafts(container, state, callbacks, language);
  }

  if (!hasLegacyQueue) return;

  const header = container.createDiv({ cls: "codex-turn-queue-header" });
  const title = header.createDiv({ cls: "codex-turn-queue-title" });
  const titleIcon = title.createSpan({ cls: "codex-turn-queue-title-icon" });
  setIcon(
    titleIcon,
    state.recoveryRequired
      ? "shield-alert"
      : state.paused
        ? "pause-circle"
        : "list-ordered"
  );
  title.createSpan({
    text: state.recoveryRequired
      ? language === "en"
        ? `Local records need recovery${state.items.length ? ` · Queue ${state.items.length}` : ""}`
        : `本地记录待恢复${state.items.length ? ` · 队列 ${state.items.length}` : ""}`
      : state.paused
        ? conversationUiText(language, `队列已暂停 · ${state.items.length}`, `Queue paused · ${state.items.length}`)
        : conversationUiText(language, `队列 · ${state.items.length}`, `Queue · ${state.items.length}`)
  });

  if (state.recoveryRequired && state.canRecover) {
    const recover = header.createEl("button", {
      cls: "codex-turn-queue-resume",
      attr: {
        type: "button",
        title: conversationUiText(language, "重试恢复本地生命周期记录", "Retry local lifecycle recovery"),
        "aria-label": conversationUiText(language, "重试恢复本地生命周期记录", "Retry local lifecycle recovery")
      }
    });
    setIcon(recover, "refresh-cw");
    recover.onclick = callbacks.onRecover;
  } else if (state.canResume) {
    const resume = header.createEl("button", {
      cls: "codex-turn-queue-resume",
      attr: {
        type: "button",
        title: conversationUiText(language, "继续队列", "Resume queue"),
        "aria-label": conversationUiText(language, "继续队列", "Resume queue")
      }
    });
    setIcon(resume, "play");
    resume.onclick = callbacks.onResume;
  }

  if (state.items.length) {
    const list = container.createDiv({ cls: "codex-turn-queue-list" });
    state.items.forEach((item, index) =>
      renderQueuedTurnItem(list, item, index, state, callbacks, language)
    );
  }
}

export function piConversationRecoveryCandidate(
  support: Readonly<PiConversationSupportState> | null
): PiConversationDiagnostic | null {
  const sessionFile = support?.catalog.sessionFile;
  if (!support || !sessionFile) return null;
  return support.diagnostics
    .filter((diagnostic) =>
      diagnostic.code === "session_recovered_prefix"
      && diagnostic.sourcePath === sessionFile
      && Boolean(diagnostic.recoveryPath)
    )
    .sort((left, right) =>
      right.createdAt - left.createdAt
      || right.diagnosticId.localeCompare(left.diagnosticId)
    )[0] ?? null;
}

export function visiblePiConversationDiagnostics(
  support: Readonly<PiConversationSupportState> | null
): PiConversationDiagnostic[] {
  if (!support) return [];
  const sessionFile = support.catalog.sessionFile;
  return support.diagnostics
    .filter((diagnostic) => {
      if (diagnostic.code === "session_recovered_prefix") return false;
      if (
        diagnostic.code === "session_jsonl_malformed"
        || diagnostic.code === "session_jsonl_truncated"
      ) {
        return Boolean(sessionFile && diagnostic.sourcePath === sessionFile);
      }
      return true;
    })
    .sort((left, right) =>
      right.createdAt - left.createdAt
      || right.diagnosticId.localeCompare(left.diagnosticId)
    );
}

function renderPiConversationDiagnostics(
  container: HTMLElement,
  diagnostics: readonly PiConversationDiagnostic[],
  recovery: PiConversationDiagnostic | null,
  state: TurnQueueState,
  callbacks: TurnQueueCallbacks,
  language: SettingsLanguage
): void {
  const panel = container.createDiv({
    cls: "codex-pi-support-panel codex-pi-diagnostic-panel"
  });
  const header = panel.createDiv({ cls: "codex-turn-queue-header" });
  const title = header.createDiv({ cls: "codex-turn-queue-title" });
  const icon = title.createSpan({ cls: "codex-turn-queue-title-icon" });
  setIcon(icon, recovery ? "shield-alert" : "triangle-alert");
  title.createSpan({
    text: recovery
      ? conversationUiText(language, "Pi 会话记录需要修复", "Pi conversation records need repair")
      : conversationUiText(language, "Pi 会话诊断", "Pi conversation diagnostics")
  });
  if (recovery?.recoveryPath) {
    const recover = header.createEl("button", {
      cls: "codex-pi-support-action",
      text: state.piRecoveryPending
        ? conversationUiText(language, "正在恢复…", "Recovering…")
        : conversationUiText(language, "恢复可验证部分", "Recover verifiable records"),
      attr: {
        type: "button",
        title: conversationUiText(language, "保留原文件，并把当前会话改绑到最后一个可验证 Entry", "Keep the original file and rebind this conversation to the last verifiable Entry")
      }
    });
    recover.disabled = !state.canManagePiSupport || state.piRecoveryPending;
    recover.onclick = () => callbacks.onRecoverPiConversation(
      recovery.recoveryPath!
    );
  }
  const list = panel.createDiv({ cls: "codex-pi-diagnostic-list" });
  for (const diagnostic of diagnostics.slice(0, 3)) {
    const item = list.createDiv({ cls: "codex-pi-diagnostic-item" });
    item.createDiv({ cls: "codex-pi-diagnostic-message", text: diagnostic.message });
    if (diagnostic.sourcePath) {
      item.createDiv({
        cls: "codex-pi-diagnostic-path",
        text: diagnostic.sourcePath,
        attr: { title: diagnostic.sourcePath }
      });
    }
  }
}

function renderPiConversationDrafts(
  container: HTMLElement,
  state: TurnQueueState,
  callbacks: TurnQueueCallbacks,
  language: SettingsLanguage
): void {
  const drafts = state.piSupport?.drafts ?? [];
  const panel = container.createDiv({
    cls: "codex-pi-support-panel codex-pi-draft-panel"
  });
  const header = panel.createDiv({ cls: "codex-turn-queue-header" });
  const title = header.createDiv({ cls: "codex-turn-queue-title" });
  const icon = title.createSpan({ cls: "codex-turn-queue-title-icon" });
  setIcon(icon, "file-pen-line");
  title.createSpan({
    text: conversationUiText(language, `待确认草稿 · ${drafts.length}`, `Drafts awaiting confirmation · ${drafts.length}`)
  });
  const list = panel.createDiv({ cls: "codex-turn-queue-list" });
  for (const draft of drafts) {
    const row = list.createDiv({
      cls: "codex-turn-queue-item codex-pi-draft-item"
    });
    const body = row.createDiv({ cls: "codex-turn-queue-body" });
    body.createDiv({ cls: "codex-turn-queue-preview", text: draft.text });
    body.createDiv({
      cls: "codex-turn-queue-meta",
      text: conversationUiText(
        language,
        `${piDraftSourceLabel(draft.source, language)} · 尚未写入 Pi Session`,
        `${piDraftSourceLabel(draft.source, language)} · Not yet written to the Pi Session`
      )
    });
    const edit = row.createEl("button", {
      cls: "codex-pi-support-action",
      text: conversationUiText(language, "继续编辑", "Continue editing"),
      attr: {
        type: "button",
        title: conversationUiText(language, "放回输入框，由你确认后重新发送", "Put this back in the input so you can confirm and resend it")
      }
    });
    edit.disabled = !state.canManagePiSupport;
    edit.onclick = () => callbacks.onEditPiDraft(draft.draftId);
    const remove = row.createEl("button", {
      cls: "codex-turn-queue-remove",
      attr: {
        type: "button",
        title: conversationUiText(language, "删除草稿", "Delete draft"),
        "aria-label": conversationUiText(language, "删除草稿", "Delete draft")
      }
    });
    remove.disabled = !state.canManagePiSupport;
    setIcon(remove, "x");
    remove.onclick = () => callbacks.onRemovePiDraft(draft.draftId);
  }
}

function piDraftSourceLabel(
  source: PiConversationSupportState["drafts"][number]["source"],
  language: SettingsLanguage = "zh-CN"
): string {
  if (language === "en") {
    if (source === "steering") return "Unconsumed steering";
    if (source === "follow_up") return "Unconsumed follow-up";
    if (source === "abort") return "Kept when stopped";
    return "Recovered after restart";
  }
  if (source === "steering") return "未消费的调整方向";
  if (source === "follow_up") return "未消费的后续消息";
  if (source === "abort") return "停止时保留";
  return "重启后恢复";
}

export function renderComposerAttachments(container: HTMLElement, state: ComposerAttachmentsState, callbacks: ComposerAttachmentsCallbacks): void {
  const language = state.language ?? "zh-CN";
  container.empty();
  container.toggleClass(
    "is-empty",
    !state.selectedSkill && state.noteMentions.length === 0 && state.attachments.length === 0
  );
  if (state.selectedSkill) {
    const presentation = resourcePresentation(state.selectedSkill, language);
    const chip = container.createDiv({ cls: "codex-skill-token" });
    const icon = chip.createSpan({ cls: "codex-skill-token-icon" });
    setIcon(icon, "box");
    chip.createSpan({ cls: "codex-skill-token-name", text: presentation.name });
    const remove = chip.createEl("button", {
      attr: {
        type: "button",
        "aria-label": conversationUiText(language, `移除 Skill：${presentation.name}`, `Remove Skill: ${presentation.name}`),
        title: conversationUiText(language, "移除 Skill", "Remove Skill")
      }
    });
    setIcon(remove, "x");
    remove.onclick = callbacks.onRemoveSkill;
  }
  if (state.noteMentions.length) {
    const mentions = container.createDiv({
      cls: "codex-note-mention-chips",
      attr: { role: "list", "aria-label": conversationUiText(language, "待发送笔记提及", "Note mentions to send") }
    });
    for (const mention of state.noteMentions) {
      const chip = mentions.createDiv({
        cls: "codex-note-mention-chip",
        attr: { role: "listitem" }
      });
      const icon = chip.createSpan({
        cls: "codex-note-mention-chip-icon",
        attr: { "aria-hidden": "true" }
      });
      setIcon(icon, "file-text");
      chip.createSpan({ cls: "codex-note-mention-chip-name", text: mention.fileName });
      const remove = chip.createEl("button", {
        cls: "codex-note-mention-chip-remove",
        attr: {
          type: "button",
          "aria-label": conversationUiText(language, `移除笔记：${mention.fileName}`, `Remove note: ${mention.fileName}`),
          title: conversationUiText(language, `移除 ${mention.fileName}`, `Remove ${mention.fileName}`)
        }
      });
      setIcon(remove, "x");
      remove.onclick = () => callbacks.onRemoveNoteMention(mention.vaultRelativePath);
    }
  }
  if (!state.attachments.length) return;
  const list = container.createDiv({ cls: "codex-ai-elements-attachments-list" });
  markAIElementsAttachments(list, "grid", conversationUiText(language, "待发送附件", "Attachments to send"));
  let imageIndex = 0;
  for (const item of state.attachments) {
    const displayIndex = item.type === "image" ? imageIndex++ : 0;
    const resource = state.attachmentResolver.resolve(item, displayIndex);
    const displayName = resource.displayName;
    if (item.type === "image") {
      const thumbnail = list.createDiv({
        cls: "codex-attachment-thumbnail",
        attr: {
          title: resource.availability === "available"
            ? displayName
            : conversationUiText(language, `${displayName} · 无法预览`, `${displayName} · Preview unavailable`),
          "aria-label": resource.availability === "available"
            ? conversationUiText(language, `图片：${displayName}`, `Image: ${displayName}`)
            : conversationUiText(language, `图片：${displayName}，无法预览`, `Image: ${displayName}; preview unavailable`)
        }
      });
      markAIElementsAttachmentItem(thumbnail, "image");
      const preview = thumbnail.createDiv({ cls: "codex-attachment-thumbnail-preview" });
      if (resource.resourceUri && resource.availability === "available") {
        const image = preview.createEl("img", {
          cls: "codex-attachment-thumbnail-image",
          attr: { alt: displayName, draggable: "false" }
        });
        image.onload = () => thumbnail.removeClass("is-broken");
        image.onerror = () => {
          renderComposerImageFallback(preview, displayName, language);
          thumbnail.addClass("is-broken");
          thumbnail.setAttribute("title", conversationUiText(language, `${displayName} · 无法预览`, `${displayName} · Preview unavailable`));
          thumbnail.setAttribute("aria-label", conversationUiText(language, `图片：${displayName}，无法预览`, `Image: ${displayName}; preview unavailable`));
        };
        image.src = resource.resourceUri;
      } else {
        renderComposerImageFallback(preview, displayName, language);
        thumbnail.addClass("is-broken");
      }
      const remove = thumbnail.createEl("button", {
        cls: "codex-attachment-thumbnail-remove",
        attr: {
          type: "button",
          "aria-label": conversationUiText(language, `移除图片：${displayName}`, `Remove image: ${displayName}`),
          title: conversationUiText(language, `移除 ${displayName}`, `Remove ${displayName}`)
        }
      });
      setIcon(remove, "x");
      remove.onclick = () => callbacks.onRemoveAttachment(item.path);
      continue;
    }
    const card = renderFileCard(list, {
      attachment: item,
      displayName,
      variant: "compact",
      availability: resource.availability,
      language,
      onOpen: () => callbacks.onOpenAttachment(item),
      onRemove: () => callbacks.onRemoveAttachment(item.path)
    });
    markAIElementsAttachmentItem(card, "document");
  }
}

function renderComposerImageFallback(
  preview: HTMLElement,
  displayName: string,
  language: SettingsLanguage
): void {
  if (preview.querySelector(".codex-attachment-thumbnail-fallback")) return;
  const fallback = preview.createDiv({
    cls: "codex-attachment-thumbnail-fallback",
    attr: { "aria-hidden": "true" }
  });
  const fallbackIcon = fallback.createSpan({ cls: "codex-attachment-thumbnail-fallback-icon" });
  setIcon(fallbackIcon, "image-off");
  fallback.createSpan({
    cls: "codex-attachment-thumbnail-name",
    text: conversationUiText(language, `${displayName} · 无法预览`, `${displayName} · Preview unavailable`)
  });
}

export function labelFor(value: string, language: SettingsLanguage = "zh-CN"): string {
  if (language === "en") {
    return ({
      none: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Maximum",
      "read-only": "Read only",
      "workspace-write": "Workspace write",
      "danger-full-access": "Full access",
      agent: "Agent",
      plan: "Plan",
      normal: "Use long-term memory",
      no_memory: "Do not use long-term Memory"
    } as Record<string, string>)[value] ?? value;
  }
  const labels: Record<string, string> = {
    none: "关闭",
    minimal: "低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
    "read-only": "只读",
    "workspace-write": "工作区可写",
    "danger-full-access": "完全访问权限",
    agent: "Agent",
    plan: "Plan",
    normal: "使用长期记忆",
    no_memory: "不使用长期 Memory"
  };
  return labels[value] ?? value;
}

export function compactReasoningLabel(
  value: ReasoningEffort,
  language: SettingsLanguage = "zh-CN"
): string {
  if (language === "en") {
    return ({
      none: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Maximum"
    } as Record<string, string>)[value] ?? value;
  }
  const labels: Record<string, string> = {
    none: "关闭",
    minimal: "低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高"
  };
  return labels[value] ?? value;
}

export function shortModelLabel(value: string, language: SettingsLanguage = "zh-CN"): string {
  if (!value.trim()) return conversationUiText(language, "未选择", "Not selected");
  return value
    .replace(/^gpt-/i, "")
    .replace(/-/g, " ")
    .replace(/\bmini\b/i, "Mini")
    .replace(/\bhigh\b/i, "High")
    .trim();
}

export function compactBrandedModelLabel(
  value: string,
  language: SettingsLanguage = "zh-CN"
): string {
  const trimmed = value.trim();
  if (!trimmed) return conversationUiText(language, "未选择", "Not selected");

  const separated = trimmed.match(/^(?:deepseek|kimi|qwen|gpt)[\s_:/-]+(.+)$/i);
  if (separated?.[1]) return separated[1];

  const adjacentVersion = trimmed.match(/^(?:qwen|gpt)(\d.*)$/i);
  return adjacentVersion?.[1] ?? value;
}

function renderQueuedTurnItem(
  container: HTMLElement,
  item: QueuedTurnItem,
  index: number,
  state: TurnQueueState,
  callbacks: TurnQueueCallbacks,
  language: SettingsLanguage
): void {
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
  body.createDiv({ cls: "codex-turn-queue-preview", text: queuedTurnPreview(item, language) });
  body.createDiv({ cls: "codex-turn-queue-meta", text: queuedTurnMeta(item, language) });

  const remove = row.createEl("button", {
    cls: "codex-turn-queue-remove",
    attr: {
      type: "button",
      title: conversationUiText(language, "删除队列项", "Delete queued item"),
      "aria-label": conversationUiText(language, "删除队列项", "Delete queued item")
    }
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

function addModelButton(
  container: HTMLElement,
  ariaLabel: string,
  title: string,
  model: string,
  providerBrand: ProviderBrandId,
  language: SettingsLanguage
): HTMLButtonElement {
  const fullModelName = model.trim()
    || conversationUiText(language, "未选择", "Not selected");
  const modelButton = container.createEl("button", {
    cls: "codex-composer-model-button codex-model-summary-button",
    attr: {
      type: "button",
      "aria-label": `${ariaLabel}：${fullModelName}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title
    }
  });
  const providerIcon = modelButton.createSpan({ cls: "codex-composer-model-icon" });
  renderProviderBrandIcon(providerIcon, providerBrand);
  modelButton.createSpan({ cls: "codex-composer-model-name", text: compactBrandedModelLabel(model) });
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
  language: SettingsLanguage,
  extraClass = ""
): void {
  const selectedLabel = labelFor(selected, language);
  const accessibleLabel = language === "en"
    ? `${label}: ${selectedLabel}`
    : `${label}：${selectedLabel}`;
  const control = container.createDiv({
    cls: `codex-composer-select ${extraClass}`.trim(),
    attr: { title: accessibleLabel }
  });
  control.dataset.value = selected;
  const icon = control.createSpan({ cls: "codex-composer-select-icon" });
  setIcon(icon, iconName);
  const select = control.createEl("select", {
    cls: "codex-select codex-composer-native-select",
    attr: { "aria-label": accessibleLabel, title: accessibleLabel }
  });
  for (const value of values) select.createEl("option", { text: labelFor(value, language), value });
  select.value = selected;
  select.onchange = () => onChange(select.value as T);
}

function addWorkspaceButton(
  container: HTMLElement,
  state: ComposerToolbarState,
  callbacks: ComposerToolbarCallbacks,
  language: SettingsLanguage
): void {
  const title = state.workspacePath
    ? conversationUiText(
      language,
      `工作区：${state.workspacePath}${state.workspaceValid ? "" : "\n文件夹不存在，请重新选择"}`,
      `Workspace: ${state.workspacePath}${state.workspaceValid ? "" : "\nFolder no longer exists. Choose it again."}`
    )
    : conversationUiText(language, "选择文件夹作为本会话工作区", "Choose a folder as this conversation's workspace");
  const button = container.createEl("button", {
    cls: "codex-composer-model-button codex-workspace-button",
    attr: {
      type: "button",
      title,
      "aria-label": conversationUiText(language, "选择工作区", "Choose workspace"),
      "aria-haspopup": "menu"
    }
  });
  button.toggleClass("has-workspace", Boolean(state.workspacePath));
  button.toggleClass("is-invalid", Boolean(state.workspacePath && !state.workspaceValid));
  const icon = button.createSpan({ cls: "codex-composer-model-icon" });
  setIcon(icon, state.workspacePath ? "folder-open" : "folder");
  button.createSpan({
    cls: "codex-composer-model-text",
    text: state.workspacePath
      ? state.workspaceDisplayName
      : conversationUiText(language, "请选择文件夹", "Choose folder")
  });
  const chevron = button.createSpan({ cls: "codex-composer-chevron" });
  setIcon(chevron, "chevron-down");
  button.onclick = (event) => callbacks.onOpenWorkspaceMenu(event, state.session);
}

function addPlanModeIndicator(container: HTMLElement, language: SettingsLanguage): void {
  const label = conversationUiText(language, "当前模式：计划", "Current mode: Plan");
  const indicator = container.createDiv({
    cls: "codex-composer-mode-indicator",
    attr: { "aria-label": label, title: label }
  });
  const icon = indicator.createSpan({ cls: "codex-composer-mode-indicator-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, "list-todo");
  indicator.createSpan({ cls: "codex-composer-mode-indicator-label", text: conversationUiText(language, "计划", "Plan") });
}

function composerActionButtonView(
  action: ReturnType<typeof composerPrimaryActionForState>,
  language: SettingsLanguage
): { icon: string; label: string; title: string } {
  if (action === "enqueue") return {
    icon: "list-plus",
    label: conversationUiText(language, "入队发送", "Queue message"),
    title: conversationUiText(language, "加入队列，当前任务结束后发送", "Add to the queue and send after the current task finishes")
  };
  if (action === "resume-queue") return {
    icon: "play",
    label: conversationUiText(language, "继续队列", "Resume queue"),
    title: conversationUiText(language, "继续队列", "Resume queue")
  };
  if (action === "stop-turn" || action === "cancel-knowledge-task") return {
    icon: "square",
    label: conversationUiText(language, "停止", "Stop"),
    title: conversationUiText(language, "停止当前任务", "Stop current task")
  };
  return {
    icon: "send",
    label: conversationUiText(language, "发送", "Send"),
    title: conversationUiText(language, "发送", "Send")
  };
}

function queuedTurnPreview(item: QueuedTurnItem, language: SettingsLanguage): string {
  const text = item.text.trim()
    || (item.noteMentions?.length
      ? conversationUiText(language, "(笔记提及)", "(note mention)")
      : item.attachments.length
        ? conversationUiText(language, "(附件)", "(attachment)")
        : "");
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function queuedTurnMeta(item: QueuedTurnItem, language: SettingsLanguage): string {
  const parts = [
    conversationUiText(language, "对话", "Conversation"),
    item.turnOptions.model
      ? shortModelLabel(item.turnOptions.model, language)
      : conversationUiText(language, "未选择", "Not selected"),
    compactReasoningLabel(item.turnOptions.reasoning, language)
  ];
  if (item.skill) parts.push(`Skill ${resourcePresentation(item.skill, language).name}`);
  if (item.attachments.length) parts.push(conversationUiText(language, `${item.attachments.length} 个附件`, `${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}`));
  if (item.noteMentions?.length) parts.push(conversationUiText(language, `${item.noteMentions.length} 篇笔记`, `${item.noteMentions.length} note${item.noteMentions.length === 1 ? "" : "s"}`));
  return parts.join(" · ");
}
