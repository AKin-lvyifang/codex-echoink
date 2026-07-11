import type { Component } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { StoredSession } from "../../settings/settings";
import { shouldCloseComposerMenusForClick } from "../composer-menu";
import { renderComposerShell } from "./composer";
import { enhanceChatInput as enhanceChatInputRunner } from "./editor-action-runner";
import { renderCodexHeader } from "./header";
import type { CodexViewPromptEnhanceContext } from "./runner-context";

export interface CodexViewShellHost extends Component {
  readonly contentEl: HTMLElement;
  readonly plugin: CodexForObsidianPlugin;
  rootEl: HTMLElement;
  headerStatusEl: HTMLElement;
  headerStatusTextEl: HTMLElement;
  editorActionStatusEl: HTMLElement;
  editorActionStatusTextEl: HTMLElement;
  headerHistoryEl: HTMLButtonElement;
  articleUnderstandingPanelEl: HTMLElement;
  headerUsageEl: HTMLButtonElement;
  headerUsageTextEl: HTMLElement;
  usagePanelEl: HTMLElement;
  tabBarEl: HTMLElement;
  knowledgeDashboardEl: HTMLElement;
  messagesEl: HTMLElement;
  virtualListEl: HTMLElement;
  queueEl: HTMLElement;
  attachmentsEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  promptEnhanceReviewEl: HTMLElement;
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
  toolbarEl: HTMLElement;
  mcpPanelEl: HTMLElement;
  articleUnderstandingPanelVisible: boolean;
  messageScrollFollow: {
    handleWheel(event: WheelEvent): void;
    handleTouchStart(event: TouchEvent): void;
    handleTouchMove(event: TouchEvent): void;
  };
  clearKnowledgeDashboardHealthTooltips(): void;
  refreshArticleUnderstandingPanelSourceState(): Promise<void>;
  renderArticleUnderstandingPanel(): void;
  ensureSession(): StoredSession;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  openKnowledgeBaseHistory(session: StoredSession): Promise<void>;
  refreshHeaderRateLimits(): Promise<void>;
  openPluginSettings(): void;
  closeComposerMenus(): void;
  handleMessagesScroll(): void;
  onInputChanged(): void;
  handlePastedFiles(event: ClipboardEvent): Promise<void>;
  sendMessage(): Promise<void>;
  handleDroppedFiles(event: DragEvent): void;
  renderToolbar(): void;
  updateInputPlaceholder(): void;
  renderEditorActionStatus(): void;
}

export function renderViewShell(host: CodexViewShellHost, editorActionRunnerContext: CodexViewPromptEnhanceContext): void {
  host.clearKnowledgeDashboardHealthTooltips();
  host.contentEl.empty();
  host.rootEl = host.contentEl.createDiv({ cls: "codex-container" });

  const headerRefs = renderCodexHeader(host.rootEl, {
    onToggleArticlePanel: () => {
      host.articleUnderstandingPanelVisible = !host.articleUnderstandingPanelVisible;
      if (host.articleUnderstandingPanelVisible) void host.refreshArticleUnderstandingPanelSourceState();
      host.renderArticleUnderstandingPanel();
    },
    onOpenHistory: () => {
      const session = host.ensureSession();
      if (!host.isKnowledgeBaseSession(session)) return;
      void host.openKnowledgeBaseHistory(session);
    },
    onRefreshRateLimits: () => host.refreshHeaderRateLimits(),
    onOpenWorkspaceResources: () => void host.plugin.openWorkspaceResourceSettings("plugins"),
    onOpenSettings: () => host.openPluginSettings()
  });
  host.headerStatusEl = headerRefs.headerStatusEl;
  host.headerStatusTextEl = headerRefs.headerStatusTextEl;
  host.editorActionStatusEl = headerRefs.editorActionStatusEl;
  host.editorActionStatusTextEl = headerRefs.editorActionStatusTextEl;
  host.headerHistoryEl = headerRefs.headerHistoryEl;
  host.headerUsageEl = headerRefs.headerUsageEl;
  host.headerUsageTextEl = headerRefs.headerUsageTextEl;
  host.usagePanelEl = headerRefs.usagePanelEl;
  host.articleUnderstandingPanelEl = headerRefs.articleUnderstandingPanelEl;
  host.registerDomEvent(document, "click", (event) => {
    const target = event.target instanceof Node ? event.target : null;
    if (!target) return;
    if (!host.rootEl.contains(target)) host.usagePanelEl.removeClass("is-visible");
    if (shouldCloseComposerMenusForClick(target, host.rootEl, [host.skillMenuEl, host.knowledgeCommandMenuEl])) host.closeComposerMenus();
  });

  host.tabBarEl = host.rootEl.createDiv({ cls: "codex-tabs" });
  host.knowledgeDashboardEl = host.rootEl.createDiv({ cls: "codex-kb-dashboard" });
  host.messagesEl = host.rootEl.createDiv({ cls: "codex-messages" });
  host.virtualListEl = host.messagesEl.createDiv({ cls: "codex-virtual-list" });
  host.registerDomEvent(host.messagesEl, "wheel", (event) => host.messageScrollFollow.handleWheel(event as WheelEvent));
  host.registerDomEvent(host.messagesEl, "touchstart", (event) => host.messageScrollFollow.handleTouchStart(event as TouchEvent));
  host.registerDomEvent(host.messagesEl, "touchmove", (event) => host.messageScrollFollow.handleTouchMove(event as TouchEvent));
  host.registerDomEvent(host.messagesEl, "scroll", () => host.handleMessagesScroll());

  const composerRefs = renderComposerShell(host.rootEl, {
    onInputChanged: () => host.onInputChanged(),
    onPasteFiles: (event) => void host.handlePastedFiles(event),
    onEnhancePrompt: () => void enhanceChatInputRunner(editorActionRunnerContext),
    onSendMessage: () => void host.sendMessage(),
    onDropFiles: (event) => host.handleDroppedFiles(event)
  });
  host.queueEl = composerRefs.queueEl;
  host.attachmentsEl = composerRefs.attachmentsEl;
  host.inputEl = composerRefs.inputEl;
  host.promptEnhanceReviewEl = composerRefs.promptEnhanceReviewEl;
  host.skillMenuEl = composerRefs.skillMenuEl;
  host.knowledgeCommandMenuEl = composerRefs.knowledgeCommandMenuEl;
  host.toolbarEl = composerRefs.toolbarEl;
  host.mcpPanelEl = host.rootEl.createDiv({ cls: "codex-mcp-panel" });
  host.renderToolbar();
  host.updateInputPlaceholder();
  host.renderEditorActionStatus();
  host.renderArticleUnderstandingPanel();
}
