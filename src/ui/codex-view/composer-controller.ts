import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { skillResourcesForScope } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { AgentBackendMode, StoredAttachment, StoredSession } from "../../settings/settings";
import type { PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode } from "../../types/app-server";
import { knowledgeCommandQueryForInput } from "../../knowledge-base/commands";
import { contextUsageView } from "../../core/mapping";
import { composerStateForRuntimeState, type ComposerPrimaryActionState } from "../composer-state";
import { RuntimeTurnQueue } from "../turn-queue";
import { setKnowledgeCommandMenuOpen } from "../knowledge-command-menu";
import {
  clearPromptEnhanceReview,
  compactReasoningLabel,
  labelFor,
  renderComposerToolbar,
  renderTurnQueue,
  shortModelLabel
} from "./composer";
import {
  openAddMenu as showAddMenu,
  openKnowledgeCommandMenu as showKnowledgeCommandMenu,
  openKnowledgeModelMenu as showKnowledgeModelMenu,
  openModelMenu as showModelMenu,
  openSkillMenu as showSkillMenu,
  renderKnowledgeCommandMatches as renderKnowledgeCommandMatchesView,
  renderSkillMatches as renderSkillMatchesView
} from "./menus";
import { normalizeWorkspacePath, workspaceDirectoryExists, workspaceDisplayName } from "./workspace-utils";

export interface CodexComposerHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  readonly turnQueue: RuntimeTurnQueue;
  toolbarEl: HTMLElement;
  workspaceEl: HTMLElement;
  queueEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  promptEnhanceReviewEl: HTMLElement;
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
  contextEl: HTMLElement;
  contextRingEl: HTMLElement;
  contextValueEl: HTMLElement;
  draggedQueueItemId: string;
  selectedSkill: EchoInkResource | null;
  attachments: StoredAttachment[];
  selectedModel: string;
  selectedReasoning: ReasoningEffort;
  selectedServiceTier: ServiceTierChoice;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  skillsRequested: boolean;
  running: boolean;
  promptEnhancerRunning: boolean;
  activeRunKind: "chat" | "knowledge-base" | "editor" | "";
  ensureSession(): StoredSession;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  resolvedKnowledgeBackend(): AgentBackendMode;
  currentEchoInkResourceCatalog(): EchoInkResource[];
  activeProviderModels(): string[];
  effectiveModel(): string;
  renderToolbar(): void;
  enhancePrompt(): void;
  renderQueue(): void;
  renderAttachments(): void;
  updateContext(tokenUsage: StoredSession["tokenUsage"], persist: boolean): void;
  runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void>;
  pickKnowledgeBaseFiles(): void;
  openKnowledgeModelMenu(event: MouseEvent): void;
  openKnowledgeCommandMenu(event: MouseEvent): void;
  openWorkspaceMenu(event: MouseEvent, session: StoredSession): void;
  openModelMenu(event: MouseEvent): void;
  pauseQueueForSession(sessionId: string): void;
  stopTurn(): Promise<void>;
  enqueueComposerDraft(): Promise<void>;
  resumeQueuedTurns(sessionId: string): Promise<void>;
  sendMessage(): Promise<void>;
  attachActiveFile(): void;
  pickFiles(imagesOnly: boolean): void;
  toggleMcpPanel(): Promise<void>;
  fillKnowledgeBaseCommand(command: string): void;
  renderKnowledgeCommandMatches(query: string): void;
}

export function renderToolbar(host: CodexComposerHost): void {
  if (!host.toolbarEl) return;
  host.renderQueue();
  host.renderAttachments();

  const session = host.ensureSession();
  const knowledgeSession = host.isKnowledgeBaseSession(session);
  const knowledgeManager = host.plugin.getKnowledgeBaseManager();
  const knowledgeTaskRunning = Boolean(knowledgeManager?.isRunning);
  const knowledgeRecoveryStatus = knowledgeManager?.maintenanceRecoveryStatus ?? {
    state: "ready" as const,
    message: ""
  };
  const workspacePath = normalizeWorkspacePath(session.cwd);
  const refs = renderComposerToolbar(
    host.toolbarEl,
    host.workspaceEl,
    {
      session,
      knowledgeSession,
      knowledgeTaskRunning,
      knowledgeRecoveryState: knowledgeRecoveryStatus.state,
      knowledgeRecoveryMessage: knowledgeRecoveryStatus.message,
      knowledgeBackend: host.resolvedKnowledgeBackend(),
      selectedSkill: host.selectedSkill,
      selectedPermission: host.selectedPermission,
      selectedMode: host.selectedMode,
      running: host.running,
      promptEnhancerRunning: host.promptEnhancerRunning,
      viewRunKind: host.activeRunKind,
      hasDraft: hasComposerDraft(host),
      hasQueuedItems: host.turnQueue.hasQueuedItems(session.id),
      currentComposerModel: shortModelLabel(host.effectiveModel()),
      currentComposerReasoning: compactReasoningLabel(host.selectedReasoning),
      currentComposerSummaryTitle: currentComposerSummaryTitle(host),
      currentKnowledgeComposerSummaryTitle: currentKnowledgeComposerSummaryTitle(host),
      workspacePath,
      workspaceDisplayName: workspacePath ? workspaceDisplayName(workspacePath) : "",
      workspaceValid: workspacePath ? workspaceDirectoryExists(workspacePath) : false
    },
    {
      onOpenAddMenu: (event) => openAddMenu(host, event),
      onOpenSkillMenu: (event) => openSkillMenu(host, event),
      onEnhancePrompt: () => host.enhancePrompt(),
      onCaptureKnowledgeSource: () => host.runKnowledgeBaseShortcut("收藏", async () => {
        const paths = await host.plugin.getKnowledgeBaseManager()?.captureLink();
        return paths?.length ? `已收藏：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未收藏内容。";
      }),
      onOpenKnowledgeModelMenu: (event) => host.openKnowledgeModelMenu(event),
      onOpenKnowledgeCommandMenu: (event) => host.openKnowledgeCommandMenu(event),
      onPermissionChange: (value) => {
        host.selectedPermission = value;
        persistComposerDefaults(host);
        host.renderToolbar();
      },
      onOpenWorkspaceMenu: (event, nextSession) => host.openWorkspaceMenu(event, nextSession),
      onOpenModelMenu: (event) => host.openModelMenu(event),
      onMicInput: () => new Notice("语音输入暂未接入"),
      onCancelKnowledgeTask: () => {
        void knowledgeManager?.cancelMaintenance().then((cancellation) => {
          if (cancellation.accepted) {
            host.pauseQueueForSession(session.id);
          }
        });
      },
      onStopTurn: () => void host.stopTurn(),
      onEnqueueDraft: () => void host.enqueueComposerDraft(),
      onResumeQueue: (sessionId) => void host.resumeQueuedTurns(sessionId),
      onSendMessage: () => void host.sendMessage()
    }
  );
  if (!knowledgeSession) {
    host.contextEl = refs.contextEl!;
    host.contextRingEl = refs.contextRingEl!;
    host.contextValueEl = refs.contextValueEl!;
    host.updateContext(session.tokenUsage, false);
  }
}

export function renderQueue(host: CodexComposerHost): void {
  if (!host.queueEl) return;
  const session = host.ensureSession();
  const knowledgeManager = host.plugin.getKnowledgeBaseManager();
  const maintenanceReady = knowledgeManager?.maintenanceRecoveryStatus.state !== "pending"
    && knowledgeManager?.maintenanceRecoveryStatus.state !== "blocked";
  renderTurnQueue(
    host.queueEl,
    {
      items: host.turnQueue.itemsForSession(session.id),
      paused: host.turnQueue.isSessionQueuePaused(session.id),
      canResume: !host.running
        && !host.promptEnhancerRunning
        && !knowledgeManager?.isRunning
        && maintenanceReady,
      draggedItemId: host.draggedQueueItemId
    },
    {
      onResume: () => void host.resumeQueuedTurns(session.id),
      onDragStart: (itemId) => {
        host.draggedQueueItemId = itemId;
      },
      onDragEnd: () => {
        host.draggedQueueItemId = "";
      },
      onReorder: (sessionId, sourceId, index) => {
        host.turnQueue.reorderQueuedItem(sessionId, sourceId, index);
        host.renderQueue();
      },
      onRemove: (sessionId, itemId) => {
        host.turnQueue.removeQueuedItem(sessionId, itemId);
        host.renderQueue();
        host.renderToolbar();
      }
    }
  );
}

export function closeComposerMenus(host: CodexComposerHost): void {
  host.skillMenuEl?.removeClass("is-visible");
  if (host.inputEl && host.knowledgeCommandMenuEl) {
    setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
  }
}

export function openSkillMenu(host: CodexComposerHost, event: MouseEvent): void {
  setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
  showSkillMenu(
    event,
    { skillMenuEl: host.skillMenuEl, knowledgeCommandMenuEl: host.knowledgeCommandMenuEl },
    { skillsRequested: host.skillsRequested },
    {
      onSkillsRequested: () => {
        host.skillsRequested = true;
      },
      onLoadSkills: () => host.plugin.ensureEchoInkSkillResourcesLoaded(true),
      onRenderMatches: () => renderSkillMatches(host)
    }
  );
}

export function openAddMenu(host: CodexComposerHost, event: MouseEvent): void {
  showAddMenu(event, {
    onAttachActiveFile: () => host.attachActiveFile(),
    onPickFiles: (imagesOnly) => host.pickFiles(imagesOnly),
    onToggleMcpPanel: () => void host.toggleMcpPanel()
  });
}

export function openKnowledgeCommandMenu(host: CodexComposerHost, event: MouseEvent): void {
  showKnowledgeCommandMenu(event, (command) => fillKnowledgeBaseCommand(host, command));
}

export function openKnowledgeModelMenu(host: CodexComposerHost, event: MouseEvent): void {
  showKnowledgeModelMenu(event, composerModelMenuState(host), {
    onSelectModel: (model) => selectComposerModel(host, model),
    onSelectReasoning: (reasoning) => selectComposerReasoning(host, reasoning)
  });
}

export function fillKnowledgeBaseCommand(host: CodexComposerHost, command: string): void {
  host.inputEl.value = command;
  clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  host.inputEl.setSelectionRange(command.length, command.length);
  closeComposerMenus(host);
  window.setTimeout(() => host.inputEl?.focus(), 50);
}

export async function submitKnowledgeBaseCommand(host: CodexComposerHost, command: string): Promise<void> {
  await host.plugin.activateKnowledgeBaseChannel();
  fillKnowledgeBaseCommand(host, command);
  await host.sendMessage();
}

export function openModelMenu(host: CodexComposerHost, event: MouseEvent): void {
  showModelMenu(event, composerModelMenuState(host), {
    onSelectModel: (model) => selectComposerModel(host, model),
    onSelectReasoning: (reasoning) => selectComposerReasoning(host, reasoning),
    onSelectServiceTier: (tier) => selectComposerServiceTier(host, tier),
    onSelectMode: (mode) => selectComposerMode(host, mode)
  });
}

export function composerModelMenuState(host: CodexComposerHost) {
  return {
    providerModels: host.activeProviderModels(),
    availableModels: host.plugin.lastStatus?.models ?? [],
    selectedModel: host.selectedModel,
    defaultModel: host.plugin.settings.defaultModel,
    effectiveModel: host.effectiveModel(),
    selectedReasoning: host.selectedReasoning,
    selectedServiceTier: host.selectedServiceTier,
    selectedMode: host.selectedMode
  };
}

export function selectComposerModel(host: CodexComposerHost, model: string): void {
  host.selectedModel = model;
  persistComposerDefaults(host);
  host.renderToolbar();
}

export function selectComposerReasoning(host: CodexComposerHost, reasoning: ReasoningEffort): void {
  host.selectedReasoning = reasoning;
  persistComposerDefaults(host);
  host.renderToolbar();
}

export function selectComposerServiceTier(host: CodexComposerHost, tier: ServiceTierChoice): void {
  host.selectedServiceTier = tier;
  persistComposerDefaults(host);
  host.renderToolbar();
}

export function selectComposerMode(host: CodexComposerHost, mode: UiMode): void {
  host.selectedMode = mode;
  persistComposerDefaults(host);
  host.renderToolbar();
}

export function currentComposerSummary(host: CodexComposerHost): string {
  return `${shortModelLabel(host.effectiveModel())} ${compactReasoningLabel(host.selectedReasoning)}`;
}

export function currentComposerSummaryTitle(host: CodexComposerHost): string {
  return `模型：${host.effectiveModel() || "自动"}\n思考：${labelFor(host.selectedReasoning)}\n速度：${labelFor(host.selectedServiceTier)}\n模式：${labelFor(host.selectedMode)}`;
}

export function currentKnowledgeComposerSummaryTitle(host: CodexComposerHost): string {
  return `知识库模型：${host.effectiveModel() || "自动"}\n思考强度：${labelFor(host.selectedReasoning)}`;
}

export function persistComposerDefaults(host: CodexComposerHost): void {
  host.plugin.settings.defaultModel = host.selectedModel;
  host.plugin.settings.defaultReasoning = host.selectedReasoning;
  host.plugin.settings.defaultServiceTier = host.selectedServiceTier;
  host.plugin.settings.defaultPermission = host.selectedPermission;
  host.plugin.settings.defaultMode = host.selectedMode;
  void host.plugin.saveSettings(true).catch((error) => {
    console.error("Codex composer defaults save failed", error);
    new Notice(`运行参数保存失败：${error instanceof Error ? error.message : String(error)}`);
  });
}

export function onInputChanged(host: CodexComposerHost): void {
  host.skillMenuEl.removeClass("is-visible");
  if (!host.inputEl.value.trim()) clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  host.renderToolbar();
  const query = knowledgeCommandQueryForInput(host.inputEl.value, host.isKnowledgeBaseSession(host.ensureSession()));
  if (query === null) {
    setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
    return;
  }
  host.renderKnowledgeCommandMatches(query);
}

export function renderSkillMatches(host: CodexComposerHost, query = ""): void {
  renderSkillMatchesView(
    host.skillMenuEl,
    query,
    {
      skills: skillResourcesForScope(host.currentEchoInkResourceCatalog(), "chat", host.plugin.settings.resources.enabledByScope),
      selectedSkill: host.selectedSkill
    },
    {
      onSelectSkill: (skill) => {
        host.selectedSkill = skill;
        host.skillMenuEl.removeClass("is-visible");
        host.renderAttachments();
        host.renderToolbar();
        host.inputEl.focus();
      }
    }
  );
}

export function renderKnowledgeCommandMatches(host: CodexComposerHost, query: string): void {
  renderKnowledgeCommandMatchesView(host.knowledgeCommandMenuEl, host.inputEl, query, (command) => fillKnowledgeBaseCommand(host, command));
}

export function hasComposerDraft(host: CodexComposerHost): boolean {
  return Boolean(host.inputEl?.value.trim() || host.attachments.length || host.selectedSkill);
}

export function clearComposerDraft(host: CodexComposerHost): void {
  host.inputEl.value = "";
  clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  closeComposerMenus(host);
  host.attachments = [];
  host.selectedSkill = null;
}

export function composerStateForSession(host: CodexComposerHost, session: StoredSession): ComposerPrimaryActionState {
  const knowledgeManager = host.plugin.getKnowledgeBaseManager();
  return composerStateForRuntimeState({
    viewRunning: host.running,
    viewRunKind: host.activeRunKind,
    globalKnowledgeTaskRunning: Boolean(knowledgeManager?.isRunning),
    hasDraft: hasComposerDraft(host),
    hasQueuedItems: host.turnQueue.hasQueuedItems(session.id)
  });
}

export function pauseQueueForSession(host: CodexComposerHost, sessionId: string): void {
  if (!host.turnQueue.hasQueuedItems(sessionId)) return;
  host.turnQueue.pauseSessionQueue(sessionId);
  host.renderQueue();
  host.renderToolbar();
}

export function updateContext(host: CodexComposerHost, tokenUsage: StoredSession["tokenUsage"], persist: boolean): void {
  updateContextForSession(host, host.ensureSession(), tokenUsage, persist);
}

export function updateContextForSession(host: CodexComposerHost, session: StoredSession, tokenUsage: StoredSession["tokenUsage"], persist: boolean): void {
  if (persist) {
    session.tokenUsage = tokenUsage;
    session.updatedAt = Date.now();
    void host.plugin.saveSettings();
  }
  if (session.id !== host.plugin.settings.activeSessionId) return;
  if (!host.contextEl) return;
  host.contextEl.toggleClass("is-hidden", !host.plugin.settings.showContext);
  if (!host.plugin.settings.showContext) return;
  const view = contextUsageView(tokenUsage);
  host.contextValueEl.setText(view.label);
  host.contextEl.setCssProps({ "--codex-context-angle": `${view.angle}deg` });
  host.contextEl.setAttr("aria-label", view.title);
  host.contextEl.setAttr("title", view.title);
  host.contextEl.toggleClass("is-empty", view.percent === null);
  host.contextEl.toggleClass("is-warning", (view.percent ?? 0) >= 80);
}
