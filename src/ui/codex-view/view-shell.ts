import { setIcon, type Component } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { StoredSession } from "../../settings/settings";
import { shouldCloseComposerMenusForClick } from "../composer-menu";
import { refreshComposerShellCopy, renderComposerShell } from "./composer";
import { refreshCodexHeaderCopy, renderCodexHeader } from "./header";
import { conversationUiText } from "./ui-i18n";

export interface CodexViewShellHost extends Component {
  readonly contentEl: HTMLElement;
  readonly plugin: CodexForObsidianPlugin;
  rootEl: HTMLElement;
  tabBarEl: HTMLElement;
  messagesEl: HTMLElement;
  virtualListEl: HTMLElement;
  jumpToLatestEl: HTMLButtonElement;
  taskPlanDockEl: HTMLElement;
  interactionDockEl: HTMLElement;
  queueEl: HTMLElement;
  attachmentsEl: HTMLElement;
  workspaceEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  promptEnhanceReviewEl: HTMLElement;
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
  resourcePanelEl: HTMLElement;
  resourcePanelAnchorEl: HTMLButtonElement;
  resourcePanelOpen: boolean;
  contextPanelEl: HTMLElement | null;
  toolbarEl: HTMLElement;
  mcpPanelEl: HTMLElement;
  messageScrollFollow: {
    handleWheel(event: WheelEvent): void;
    handleTouchStart(event: TouchEvent): void;
    handleTouchMove(event: TouchEvent): void;
  };
  ensureSession(): StoredSession;
  openPluginSettings(): void;
  closeComposerMenus(): void;
  handleMessagesScroll(): void;
  jumpToLatest(): void;
  onInputChanged(): void;
  handlePastedFiles(event: ClipboardEvent): Promise<void>;
  sendMessage(): Promise<void>;
  handleDroppedFiles(event: DragEvent): void;
  renderToolbar(): void;
  renderTaskPlanDock(session: StoredSession): void;
  renderInteractionDock(session: StoredSession): void;
  updateInputPlaceholder(): void;
  returnQuickChatToSidebar(): void;
}

export function renderViewShell(host: CodexViewShellHost): void {
  host.contentEl.empty();
  host.rootEl = host.contentEl.createDiv({ cls: "codex-container" });

  renderCodexHeader(host.rootEl, {
    onOpenWorkspaceResources: () => void host.plugin.openWorkspaceResourceSettings("plugins"),
    onOpenSettings: () => {
      void host.plugin.handleEchoInkOnboardingTargetActivated("settings")
        .then((handled) => {
          if (!handled) host.openPluginSettings();
        })
        .catch(() => host.openPluginSettings());
    },
    onReturnToSidebar: () => host.returnQuickChatToSidebar()
  }, host.plugin.getEchoInkAgentIdentityView(), host.plugin.settings.settingsLanguage);
  host.registerDomEvent(document, "click", (event) => {
    const target = event.target instanceof Node ? event.target : null;
    if (!target) return;
    if (host.contextPanelEl?.contains(target)) return;
    if (shouldCloseComposerMenusForClick(target, host.rootEl, [
      host.skillMenuEl,
      host.knowledgeCommandMenuEl,
      host.inputEl?.parentElement?.querySelector<HTMLElement>(".codex-note-mention-menu"),
      host.resourcePanelEl,
      host.resourcePanelAnchorEl
    ])) host.closeComposerMenus();
  });

  host.tabBarEl = host.rootEl.createDiv({ cls: "codex-tabs" });
  const messagesShell = host.rootEl.createDiv({ cls: "codex-messages-shell" });
  host.messagesEl = messagesShell.createDiv({ cls: "codex-messages" });
  host.virtualListEl = host.messagesEl.createDiv({ cls: "codex-virtual-list" });
  host.registerDomEvent(host.messagesEl, "wheel", (event) => host.messageScrollFollow.handleWheel(event as WheelEvent));
  host.registerDomEvent(host.messagesEl, "touchstart", (event) => host.messageScrollFollow.handleTouchStart(event as TouchEvent));
  host.registerDomEvent(host.messagesEl, "touchmove", (event) => host.messageScrollFollow.handleTouchMove(event as TouchEvent));
  host.registerDomEvent(host.messagesEl, "scroll", () => host.handleMessagesScroll());
  host.jumpToLatestEl = messagesShell.createEl("button", {
    cls: "codex-jump-to-latest",
    attr: { type: "button" }
  });
  host.jumpToLatestEl.hidden = true;
  const jumpIcon = host.jumpToLatestEl.createSpan({
    cls: "codex-jump-to-latest-icon",
    attr: { "aria-hidden": "true" }
  });
  setIcon(jumpIcon, "arrow-down");
  host.jumpToLatestEl.createSpan({ cls: "codex-jump-to-latest-label" });
  host.registerDomEvent(host.jumpToLatestEl, "click", () => host.jumpToLatest());
  host.taskPlanDockEl = host.rootEl.createDiv({ cls: "codex-task-plan-dock" });
  host.interactionDockEl = host.rootEl.createDiv({
    cls: "codex-interaction-dock",
    attr: {
      "aria-live": "polite"
    }
  });
  applyViewShellCopy(host);
  const composerRefs = renderComposerShell(host.rootEl, {
    onInputChanged: () => host.onInputChanged(),
    onPasteFiles: (event) => void host.handlePastedFiles(event),
    onSendMessage: () => void host.sendMessage(),
    onDropFiles: (event) => host.handleDroppedFiles(event)
  }, host.plugin.settings.settingsLanguage);
  host.queueEl = composerRefs.queueEl;
  host.attachmentsEl = composerRefs.attachmentsEl;
  host.workspaceEl = composerRefs.workspaceEl;
  host.inputEl = composerRefs.inputEl;
  host.promptEnhanceReviewEl = composerRefs.promptEnhanceReviewEl;
  host.skillMenuEl = composerRefs.skillMenuEl;
  host.knowledgeCommandMenuEl = composerRefs.knowledgeCommandMenuEl;
  host.resourcePanelEl = composerRefs.resourcePanelEl;
  host.resourcePanelOpen = false;
  host.toolbarEl = composerRefs.toolbarEl;
  host.mcpPanelEl = host.rootEl.createDiv({ cls: "codex-mcp-panel" });
  host.renderToolbar();
  host.updateInputPlaceholder();
}

export function refreshViewShellCopy(host: CodexViewShellHost): void {
  if (!host.rootEl) return;
  refreshCodexHeaderCopy(host.rootEl, host.plugin.settings.settingsLanguage);
  refreshComposerShellCopy(host.rootEl, host.plugin.settings.settingsLanguage);
  applyViewShellCopy(host);
}

function applyViewShellCopy(host: CodexViewShellHost): void {
  const language = host.plugin.settings.settingsLanguage;
  const jumpLabel = conversationUiText(language, "跳到最新消息", "Jump to latest message");
  host.jumpToLatestEl?.setAttribute("title", jumpLabel);
  host.jumpToLatestEl?.setAttribute("aria-label", jumpLabel);
  const jumpText = host.jumpToLatestEl?.querySelector<HTMLElement>(".codex-jump-to-latest-label");
  if (jumpText) jumpText.setText(conversationUiText(language, "跳到最新", "Jump to latest"));
  host.interactionDockEl?.setAttribute(
    "aria-label",
    conversationUiText(language, "当前会话交互", "Current conversation interactions")
  );
}
