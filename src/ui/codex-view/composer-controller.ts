import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { enabledSkillResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import {
  activateApiProviderModel,
  apiProviderHasUsableCredential,
  getActiveApiProvider,
  getApiProviderModel,
  type StoredAttachment,
  type StoredSession
} from "../../settings/settings";
import type { EchoInkPiReasoningOption } from "../../settings/pi-model-catalog";
import type { ProviderBrandId } from "../../settings/provider-brand-icons";
import {
  apiProviderConfiguredDisplayName,
  normalizeApiProviderId
} from "../../settings/provider-presets";
import type { PermissionMode, ReasoningEffort, UiMode } from "../../types/app-server";
import { knowledgeCommandQueryForInput } from "../../knowledge-base/commands";
import { contextUsageView } from "../../core/mapping";
import { composerStateForRuntimeState, type ComposerPrimaryActionState } from "../composer-state";
import { RuntimeTurnQueue } from "../turn-queue";
import { setKnowledgeCommandMenuOpen } from "../knowledge-command-menu";
import {
  clearPromptEnhanceReview,
  compactReasoningLabel,
  labelFor,
  renderContextPanel,
  renderComposerResourcePanel,
  renderComposerNoteMentionMenu,
  renderComposerToolbar,
  renderTurnQueue,
  shortModelLabel
} from "./composer";
import {
  addComposerNoteMentionSelection,
  buildVaultNoteMentionCatalog,
  cachedComposerNoteMentionCatalog,
  clearComposerNoteMentions,
  closeComposerNoteMentionMenu,
  composerNoteMentionMenuState,
  composerNoteMentionSelections,
  noteMentionQueryAtCursor,
  removeNoteMentionQuery,
  searchNoteMentionCatalog,
  setComposerNoteMentionMenu
} from "./note-mentions";
import { currentDisplayedMarkdownFile } from "./attachments";
import {
  openKnowledgeCommandMenu as showKnowledgeCommandMenu,
  openModelMenu as showModelMenu,
  openSkillMenu as showSkillMenu,
  renderKnowledgeCommandMatches as renderKnowledgeCommandMatchesView,
  renderSkillMatches as renderSkillMatchesView,
  type ComposerProviderModelOption
} from "./menus";
import { normalizeWorkspacePath, workspaceDirectoryExists, workspaceDisplayName } from "./workspace-utils";
import {
  clearSelectedPiConversationDraft,
  isPiConversationRecovering,
  piConversationSupport,
  projectPiImageAttachments,
  refreshPiConversationSupport,
  rememberPiConversationProjection,
  selectPiConversationDraft,
  setPiConversationRecovering
} from "./pi-conversation-support";
import { positionAnchoredMenu } from "./floating-menu-position";
import {
  applyComposerReasoningFallback,
  resolveComposerReasoningState,
  type ComposerReasoningState
} from "../composer-reasoning";
import { conversationUiText } from "./ui-i18n";

let contextPopoverId = 0;

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
  resourcePanelEl: HTMLElement;
  resourcePanelAnchorEl: HTMLButtonElement;
  resourcePanelOpen: boolean;
  resourcePanelResources: EchoInkResource[];
  contextEl: HTMLElement;
  contextRingEl: HTMLElement;
  contextPanelEl: HTMLElement | null;
  contextPanelCleanup: (() => void) | null;
  contextPanelReposition: (() => void) | null;
  contextPanelOpen: boolean;
  draggedQueueItemId: string;
  selectedSkill: EchoInkResource | null;
  attachments: StoredAttachment[];
  selectedProviderSettingsId: string;
  selectedModel: string;
  selectedPermission: PermissionMode;
  selectedMode: UiMode;
  skillsRequested: boolean;
  running: boolean;
  promptEnhancerRunning: boolean;
  activeRunKind: "chat" | "";
  activeRunSessionId: string;
  ensureSession(): StoredSession;
  currentEchoInkResourceCatalog(): EchoInkResource[];
  effectiveModel(): string;
  renderToolbar(): void;
  renderMessages(options?: {
    forceBottom?: boolean;
    preserveScroll?: boolean;
  }): void;
  resetVirtualWindow(): void;
  enhancePrompt(): void;
  renderQueue(): void;
  renderAttachments(): void;
  updateContext(tokenUsage: StoredSession["tokenUsage"], persist: boolean): void;
  runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void>;
  pickKnowledgeBaseFiles(): void;
  openKnowledgeCommandMenu(event: MouseEvent): void;
  openWorkspaceMenu(event: MouseEvent, session: StoredSession): void;
  openModelMenu(event: MouseEvent): void;
  pauseQueueForSession(sessionId: string): void;
  stopTurn(): Promise<void>;
  steerPiChatFromComposer(): Promise<void>;
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
  ensureComposerReasoningPreference(host);
  disposeContextPopover(host);
  host.renderQueue();
  host.renderAttachments();

  const session = host.ensureSession();
  const knowledgeManager = host.plugin.getKnowledgeSurfaceService();
  const knowledgeTaskRunning = Boolean(knowledgeManager?.isRunning);
  const workspacePath = normalizeWorkspacePath(session.cwd);
  const refs = renderComposerToolbar(
    host.toolbarEl,
    host.workspaceEl,
    {
      language: host.plugin.settings.settingsLanguage,
      session,
      knowledgeTaskRunning,
      selectedSkill: host.selectedSkill,
      selectedPermission: host.selectedPermission,
      selectedMode: host.selectedMode,
      running: host.running,
      promptEnhancerRunning: host.promptEnhancerRunning,
      viewRunKind: host.activeRunKind,
      activeRunSessionId: host.activeRunSessionId,
      hasDraft: hasComposerDraft(host),
      hasTextDraft: Boolean(host.inputEl.value.trim()),
      hasQueuedItems: host.turnQueue.hasQueuedItems(session.id),
      currentComposerModel: host.effectiveModel(),
      currentComposerProviderBrand: currentComposerProviderBrand(host),
      currentComposerSummaryTitle: currentComposerSummaryTitle(host),
      workspacePath,
      workspaceDisplayName: workspacePath ? workspaceDisplayName(workspacePath) : "",
      workspaceValid: workspacePath ? workspaceDirectoryExists(workspacePath) : false,
      contextLedger: session.contextLedger,
      contextPanelOpen: host.contextPanelOpen
    },
    {
      onOpenAddMenu: (event) => openAddMenu(host, event),
      onEnhancePrompt: () => host.enhancePrompt(),
      onCaptureKnowledgeSource: () => {
        void host.runKnowledgeBaseShortcut(
          conversationUiText(host.plugin.settings.settingsLanguage, "收藏", "Save"),
          async () => {
            const paths = await host.plugin.getKnowledgeSurfaceService()?.captureLink();
            return paths?.length
              ? conversationUiText(
                host.plugin.settings.settingsLanguage,
                `已收藏：\n${paths.map((item) => `- ${item}`).join("\n")}`,
                `Saved:\n${paths.map((item) => `- ${item}`).join("\n")}`
              )
              : conversationUiText(host.plugin.settings.settingsLanguage, "未收藏内容。", "Nothing was saved.");
          }
        ).catch((error: unknown) => {
          host.running = false;
          host.renderToolbar();
          const detail = error instanceof Error ? error.message : String(error);
          new Notice(conversationUiText(
            host.plugin.settings.settingsLanguage,
            `收藏失败：${detail}`,
            `Save failed: ${detail}`
          ));
        });
      },
      onPermissionChange: (value) => {
        host.selectedPermission = value;
        persistComposerDefaults(host);
        host.renderToolbar();
      },
      onOpenWorkspaceMenu: (event, nextSession) => host.openWorkspaceMenu(event, nextSession),
      onOpenModelMenu: (event) => host.openModelMenu(event),
      onToggleContextPanel: () => {
        if (host.contextPanelOpen) {
          closeContextPopover(host, true);
          return;
        }
        host.contextPanelOpen = true;
        host.renderToolbar();
        host.contextPanelEl?.focus();
      },
      onMicInput: () => new Notice(conversationUiText(
        host.plugin.settings.settingsLanguage,
        "语音输入暂未接入",
        "Voice input is not available yet"
      )),
      onCancelKnowledgeTask: () => {
        void knowledgeManager?.cancelMaintenance().then((cancellation) => {
          if (cancellation.accepted) {
            host.pauseQueueForSession(session.id);
          }
        });
      },
      onStopTurn: () => void stopTurnFromComposer(host, session),
      onSteerPiChat: () => void host.steerPiChatFromComposer(),
      onEnqueueDraft: () => void host.enqueueComposerDraft(),
      onResumeQueue: (sessionId) => void host.resumeQueuedTurns(sessionId),
      onSendMessage: () => void host.sendMessage()
    }
  );
  host.contextEl = refs.contextEl!;
  host.resourcePanelAnchorEl = refs.addButtonEl!;
  host.resourcePanelAnchorEl.setAttribute("aria-expanded", String(host.resourcePanelOpen));
  host.contextRingEl = refs.contextRingEl!;
  syncContextPopover(host, session.contextLedger);
  renderComposerResourcePanel(
    host.resourcePanelEl,
    {
      open: host.resourcePanelOpen,
      selectedSkill: host.selectedSkill,
      selectedMode: host.selectedMode,
      resources: host.resourcePanelResources.length
        ? host.resourcePanelResources
        : host.currentEchoInkResourceCatalog(),
      resourceSettings: host.plugin.settings.resources,
      language: host.plugin.settings.settingsLanguage,
      canAttachActiveFile: currentDisplayedMarkdownFile(host.app) !== null
    },
    {
      onDismiss: (restoreFocus) => closeResourcePanel(host, restoreFocus),
      onPickFiles: (imagesOnly) => {
        closeResourcePanel(host, false);
        host.pickFiles(imagesOnly);
      },
      onAttachActiveFile: () => {
        closeResourcePanel(host, false);
        host.attachActiveFile();
      },
      onSelectPlanMode: () => {
        closeResourcePanel(host, false);
        selectComposerMode(host, "plan");
      },
      onSelectSkill: (skill) => {
        host.selectedSkill = skill;
        closeResourcePanel(host, false);
        host.renderAttachments();
        host.renderToolbar();
        host.inputEl.focus();
      },
      onOpenMcpSettings: () => {
        closeResourcePanel(host, false);
        void host.plugin.openWorkspaceResourceSettings("mcp");
      }
    }
  );
  host.updateContext(session.tokenUsage, false);
}

export function renderQueue(host: CodexComposerHost): void {
  if (!host.queueEl) return;
  const session = host.ensureSession();
  const knowledgeManager = host.plugin.getKnowledgeSurfaceService();
  const maintenanceReady = (knowledgeManager?.maintenanceRecoveryStatus?.state ?? "ready") === "ready";
  const maintenanceRecoveryBlocksHead = false;
  const piSupport = session.bodyAuthority === "pi_session_only"
    ? piConversationSupport(host.plugin, session.id)
    : null;
  renderTurnQueue(
    host.queueEl,
    {
      language: host.plugin.settings.settingsLanguage,
      items: host.turnQueue.itemsForSession(session.id),
      paused: host.turnQueue.isSessionQueuePaused(session.id)
        || host.turnQueue.isSessionRecoveryRequired(session.id),
      canResume: !host.running
        && !host.promptEnhancerRunning
        && !knowledgeManager?.isRunning
        && !maintenanceRecoveryBlocksHead
        && !host.turnQueue.isSessionRecoveryRequired(session.id),
      recoveryRequired:
        host.turnQueue.isSessionRecoveryRequired(session.id),
      canRecover: !host.running
        && !host.promptEnhancerRunning
        && !knowledgeManager?.isRunning,
      draggedItemId: host.draggedQueueItemId,
      piSupport,
      piRecoveryPending: isPiConversationRecovering(
        host.plugin,
        session.id
      ),
      canManagePiSupport: !host.running
        && !host.promptEnhancerRunning
        && !knowledgeManager?.isRunning
    },
    {
      onResume: () => void host.resumeQueuedTurns(session.id),
      onRecover: () => undefined,
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
      },
      onEditPiDraft: (draftId) => editPiConversationDraft(
        host,
        session.id,
        draftId
      ),
      onRemovePiDraft: (draftId) => void removePiConversationDraft(
        host,
        session.id,
        draftId
      ),
      onRecoverPiConversation: (recoveryPath) =>
        void recoverPiConversation(host, session, recoveryPath)
    }
  );
}

export function editPiConversationDraft(
  host: CodexComposerHost,
  conversationId: string,
  draftId: string
): boolean {
  const draft = selectPiConversationDraft(
    host.plugin,
    conversationId,
    draftId
  );
  if (!draft) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "这条 Pi 草稿已经不存在，请刷新后重试。",
      "This Pi draft no longer exists. Refresh and try again."
    ));
    return false;
  }
  host.inputEl.value = draft.text;
  host.inputEl.setSelectionRange(draft.text.length, draft.text.length);
  clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  host.renderToolbar();
  host.inputEl.focus();
  return true;
}

export async function removePiConversationDraft(
  host: CodexComposerHost,
  conversationId: string,
  draftId: string
): Promise<boolean> {
  try {
    const removed = await host.plugin.discardPiConversationDraft(
      conversationId,
      draftId
    );
    await refreshPiConversationSupport(host.plugin, conversationId);
    clearSelectedPiConversationDraft(host.plugin, conversationId);
    host.renderToolbar();
    if (removed) new Notice(conversationUiText(host.plugin.settings.settingsLanguage, "Pi 草稿已删除", "Pi draft deleted"));
    return removed;
  } catch (error) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      `删除 Pi 草稿失败：${errorMessage(error)}`,
      `Could not delete the Pi draft: ${errorMessage(error)}`
    ));
    return false;
  }
}

export async function recoverPiConversation(
  host: CodexComposerHost,
  session: StoredSession,
  recoveryPath: string
): Promise<boolean> {
  setPiConversationRecovering(host.plugin, session.id, true);
  host.renderToolbar();
  try {
    const recovered = await host.plugin.recoverPiConversationFromVerifiedPrefix({
      conversationId: session.id,
      recoveryPath
    });
    const projection = await host.plugin.readPiConversationProjection(session.id);
    rememberPiConversationProjection(host.plugin, projection);
    session.title = projection.catalog.title;
    session.piSessionId = projection.catalog.piSessionId;
    session.defaultMemoryMode = projection.catalog.defaultMemoryMode;
    session.bodyAuthority = "pi_session_only";
    session.messages = projectPiImageAttachments(
      session,
      structuredClone(projection.messages)
    );
    if (projection.contextLedger) {
      session.contextLedger = structuredClone(projection.contextLedger);
    } else {
      delete session.contextLedger;
    }
    session.createdAt = projection.catalog.createdAt;
    session.updatedAt = projection.catalog.updatedAt;
    host.resetVirtualWindow();
    host.renderMessages({ forceBottom: true });
    new Notice(
      conversationUiText(
        host.plugin.settings.settingsLanguage,
        `已恢复 ${recovered.recoveredEntryCount} 条可验证记录；原损坏文件已保留。`,
        `Recovered ${recovered.recoveredEntryCount} verifiable records; the original damaged file was kept.`
      )
    );
    return true;
  } catch (error) {
    await refreshPiConversationSupport(host.plugin, session.id)
      .catch(() => undefined);
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      `恢复 Pi 会话失败：${errorMessage(error)}`,
      `Could not recover the Pi conversation: ${errorMessage(error)}`
    ));
    return false;
  } finally {
    setPiConversationRecovering(host.plugin, session.id, false);
    host.renderToolbar();
  }
}

export function closeComposerMenus(host: CodexComposerHost): void {
  host.skillMenuEl?.removeClass("is-visible");
  closeComposerNoteMentionMenu(host.inputEl);
  closeResourcePanel(host, false);
  closeContextPopover(host, false);
  if (host.inputEl && host.knowledgeCommandMenuEl) {
    setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
  }
}

export function openSkillMenu(host: CodexComposerHost, event: MouseEvent): void {
  closeComposerNoteMentionMenu(host.inputEl);
  setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
  showSkillMenu(
    event,
    { skillMenuEl: host.skillMenuEl, knowledgeCommandMenuEl: host.knowledgeCommandMenuEl },
    {
      language: host.plugin.settings.settingsLanguage,
      skillsRequested: host.skillsRequested
    },
    {
      onSkillsRequested: () => {
        host.skillsRequested = true;
      },
      onLoadSkills: async () => enabledSkillsForComposerMenu(
        await host.plugin.ensureEchoInkSkillResourcesLoaded(true)
      ),
      onRenderMatches: (skills) => renderSkillMatches(host, "", skills)
    }
  );
}

export function openAddMenu(host: CodexComposerHost, event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  closeComposerNoteMentionMenu(host.inputEl);
  if (host.resourcePanelOpen) {
    closeResourcePanel(host, true);
    return;
  }
  host.skillMenuEl.removeClass("is-visible");
  setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
  host.resourcePanelOpen = true;
  host.resourcePanelResources = host.currentEchoInkResourceCatalog();
  host.renderToolbar();
  host.resourcePanelEl.querySelector<HTMLButtonElement>(".codex-composer-resource-row")?.focus();
  void host.plugin.buildRuntimeEchoInkResourceCatalog().then((resources) => {
    if (!host.resourcePanelOpen) return;
    host.resourcePanelResources = resources;
    host.renderToolbar();
    host.resourcePanelEl.querySelector<HTMLButtonElement>(".codex-composer-resource-row")?.focus();
  }).catch(() => undefined);
}

function closeResourcePanel(host: CodexComposerHost, restoreFocus: boolean): void {
  if (!host.resourcePanelOpen && !host.resourcePanelEl?.hasClass("is-visible")) return;
  host.resourcePanelOpen = false;
  host.resourcePanelEl?.removeClass("is-visible");
  host.resourcePanelEl?.setAttribute("aria-hidden", "true");
  host.resourcePanelAnchorEl?.setAttribute("aria-expanded", "false");
  if (restoreFocus) host.resourcePanelAnchorEl?.focus();
}

export function openKnowledgeCommandMenu(host: CodexComposerHost, event: MouseEvent): void {
  closeComposerNoteMentionMenu(host.inputEl);
  showKnowledgeCommandMenu(
    event,
    (command) => fillKnowledgeBaseCommand(host, command),
    host.plugin.settings.settingsLanguage
  );
}

export function fillKnowledgeBaseCommand(host: CodexComposerHost, command: string): void {
  host.inputEl.value = command;
  clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  host.inputEl.setSelectionRange(command.length, command.length);
  closeComposerMenus(host);
  window.setTimeout(() => host.inputEl?.focus(), 50);
}

export async function submitKnowledgeBaseCommand(host: CodexComposerHost, command: string): Promise<void> {
  fillKnowledgeBaseCommand(host, command);
  await host.sendMessage();
}

export function openModelMenu(host: CodexComposerHost, event: MouseEvent): void {
  showModelMenu(event, composerModelMenuState(host), {
    onSelectModel: (selection) => void selectComposerModel(host, selection),
    onSelectReasoning: (reasoning) => selectComposerReasoning(host, reasoning),
    onSelectMode: (mode) => selectComposerMode(host, mode)
  });
}

export function composerModelMenuState(host: CodexComposerHost) {
  const reasoning = ensureComposerReasoningPreference(host);
  return {
    language: host.plugin.settings.settingsLanguage,
    providerModels: composerProviderModelOptions(host),
    selectedProviderSettingsId: host.selectedProviderSettingsId,
    selectedModel: host.selectedModel,
    selectedReasoning: reasoning?.effort ?? null,
    reasoningCurrentValue: composerReasoningCurrentValue(reasoning, host.plugin.settings.settingsLanguage),
    reasoningDisabledReason: composerReasoningDisabledReason(reasoning, host.plugin.settings.settingsLanguage),
    reasoningAdjustable: reasoning?.adjustable ?? false,
    reasoningOptions: reasoning?.adjustable
      ? reasoning.enabledOptions.map((option) => ({
          effort: option.effort,
          label: composerReasoningOptionLabel(option, host.plugin.settings.settingsLanguage)
        }))
      : [],
    selectedMode: host.selectedMode
  };
}

export function composerProviderModelOptions(
  host: Pick<CodexComposerHost, "plugin">
): ComposerProviderModelOption[] {
  const settings = host.plugin.settings;
  return settings.apiProviders.flatMap((provider) =>
    apiProviderHasUsableCredential(provider, settings.openAICodexCredential)
      ? provider.models.map((model) => ({
          providerSettingsId: provider.id,
          providerName: apiProviderConfiguredDisplayName(
            normalizeApiProviderId(
              provider.providerId,
              provider.baseUrl,
              provider.name
            ),
            provider.name,
            settings.settingsLanguage
          ),
          modelId: model.id,
          modelName: model.displayName || model.id
        }))
      : []
  );
}

export async function selectComposerModel(
  host: CodexComposerHost,
  selection: Readonly<{
    providerSettingsId: string;
    modelId: string;
  }>
): Promise<boolean> {
  let correctedReasoning: Readonly<ComposerReasoningState> | null = null;
  const target = host.plugin.settings.apiProviders.find(
    (provider) => provider.id === selection.providerSettingsId
  );
  const targetModel = target && getApiProviderModel(target, selection.modelId);
  if (
    !target
    || !targetModel
    || !apiProviderHasUsableCredential(
      target,
      host.plugin.settings.openAICodexCredential
    )
  ) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "所选 Provider 或模型已不可用，请先检查 Provider 设置",
      "The selected Provider or model is unavailable. Check Provider settings first."
    ));
    return false;
  }
  try {
    await host.plugin.activateApiProviderSettings((settings) => {
      const candidate = settings.apiProviders.find(
        (provider) => provider.id === selection.providerSettingsId
      );
      if (
        !candidate
        || !apiProviderHasUsableCredential(
          candidate,
          settings.openAICodexCredential
        )
      ) {
        throw new Error("Provider authentication unavailable");
      }
      activateApiProviderModel(settings, candidate, selection.modelId);
      const reasoning = resolveComposerReasoningState(
        settings,
        selection.providerSettingsId,
        selection.modelId
      );
      if (reasoning && applyComposerReasoningFallback(reasoning)) {
        if (reasoning.status === "invalid") correctedReasoning = reasoning;
      }
    });
  } catch (error) {
    new Notice(
      conversationUiText(
        host.plugin.settings.settingsLanguage,
        `切换 Provider/模型失败：${error instanceof Error ? error.message : String(error)}`,
        `Could not switch Provider/model: ${error instanceof Error ? error.message : String(error)}`
      )
    );
    return false;
  }
  host.selectedProviderSettingsId = selection.providerSettingsId;
  host.selectedModel = selection.modelId;
  ensureComposerReasoningPreference(host);
  host.renderToolbar();
  if (correctedReasoning) showComposerReasoningFallbackNotice(
    correctedReasoning,
    host.plugin.settings.settingsLanguage
  );
  const providerName = apiProviderConfiguredDisplayName(
    normalizeApiProviderId(
      target.providerId,
      target.baseUrl,
      target.name
    ),
    target.name,
    host.plugin.settings.settingsLanguage
  );
  new Notice(host.plugin.settings.settingsLanguage === "en"
    ? `Switched to ${providerName} · ${targetModel.displayName || targetModel.id}`
    : `已切换到 ${providerName} · ${targetModel.displayName || targetModel.id}`);
  return true;
}

export function selectComposerReasoning(host: CodexComposerHost, reasoning: ReasoningEffort): void {
  const state = ensureComposerReasoningPreference(host);
  if (
    !state
    || !state.enabled
    || !state.adjustable
    || !state.enabledOptions.some((option) => option.effort === reasoning)
  ) {
    new Notice(state && !state.enabled
      ? conversationUiText(host.plugin.settings.settingsLanguage, "请先在模型设置中开启深度思考", "Enable reasoning in Model settings first")
      : state && !state.adjustable
        ? conversationUiText(host.plugin.settings.settingsLanguage, "当前模型的思考强度由模型决定", "This model determines its own reasoning effort")
        : conversationUiText(host.plugin.settings.settingsLanguage, "当前模型不支持这个思考强度，请重新选择", "This model does not support that reasoning effort. Choose another one."));
    return;
  }
  state.model.reasoningEffort = reasoning;
  saveComposerSettings(host, conversationUiText(host.plugin.settings.settingsLanguage, "思考强度", "reasoning effort"));
  host.renderToolbar();
}

export function selectComposerMode(host: CodexComposerHost, mode: UiMode): void {
  host.selectedMode = mode;
  persistComposerDefaults(host);
  host.renderToolbar();
}

export function currentComposerSummary(host: CodexComposerHost): string {
  const language = host.plugin.settings.settingsLanguage;
  const model = shortModelLabel(host.effectiveModel(), language);
  const reasoning = ensureComposerReasoningPreference(host);
  if (!reasoning?.supported || !reasoning.enabled || reasoning.effort === "none") {
    return model;
  }
  const option = reasoning.enabledOptions.find(
    (candidate) => candidate.effort === reasoning.effort
  );
  return `${model} ${option?.display === "toggle"
    ? conversationUiText(language, "默认", "Default")
    : compactReasoningLabel(reasoning.effort, language)}`;
}

export function currentComposerSummaryTitle(host: CodexComposerHost): string {
  const language = host.plugin.settings.settingsLanguage;
  const model = host.effectiveModel() || conversationUiText(language, "未选择", "Not selected");
  return conversationUiText(
    language,
    `模型：${model}\n打开模型和运行参数`,
    `Model: ${model}\nOpen model and run settings`
  );
}

export function currentComposerProviderBrand(host: CodexComposerHost): ProviderBrandId {
  const providerId = getActiveApiProvider(host.plugin.settings)?.providerId;
  switch (providerId) {
    case "glm":
    case "kimi":
    case "minimax":
    case "deepseek":
    case "qwen":
    case "ollama":
    case "custom":
      return providerId;
    case "qwen-token-plan":
      return "qwen";
    default:
      return "custom";
  }
}

export function persistComposerDefaults(host: CodexComposerHost): void {
  host.plugin.settings.defaultModel = host.selectedModel;
  host.plugin.settings.defaultPermission = host.selectedPermission;
  host.plugin.settings.defaultMode = host.selectedMode;
  saveComposerSettings(host, conversationUiText(host.plugin.settings.settingsLanguage, "运行参数", "run settings"));
}

export function ensureComposerReasoningPreference(
  host: Pick<
    CodexComposerHost,
    "plugin" | "selectedProviderSettingsId" | "selectedModel"
  >,
  notify = true
): Readonly<ComposerReasoningState> | null {
  const state = resolveComposerReasoningState(
    host.plugin.settings,
    host.selectedProviderSettingsId,
    host.selectedModel
  );
  if (!state || !applyComposerReasoningFallback(state)) return state;
  saveComposerSettings(host, conversationUiText(host.plugin.settings.settingsLanguage, "思考强度", "reasoning effort"));
  if (notify && state.status === "invalid") {
    showComposerReasoningFallbackNotice(state, host.plugin.settings.settingsLanguage);
  }
  return state;
}

function showComposerReasoningFallbackNotice(
  state: Readonly<ComposerReasoningState>,
  language: "zh-CN" | "en"
): void {
  const modelName = state.model.displayName || state.model.id;
  if (state.effort) {
    new Notice(
      conversationUiText(
        language,
        `${modelName} 原思考强度已不可用，已回落为${composerReasoningEffortLabel(state, language)}`,
        `${modelName}'s saved reasoning effort is no longer available and was reset to ${composerReasoningEffortLabel(state, language)}`
      )
    );
  } else {
    new Notice(conversationUiText(
      language,
      `${modelName} 已不支持可配置深度思考，原偏好已移除`,
      `${modelName} no longer supports configurable reasoning; the saved preference was removed`
    ));
  }
}

function composerReasoningEffortLabel(
  state: Readonly<ComposerReasoningState>,
  language: "zh-CN" | "en"
): string {
  const option = state.enabledOptions.find(
    (candidate) => candidate.effort === state.effort
  );
  return option
    ? composerReasoningOptionLabel(option, language)
    : conversationUiText(language, "合法默认值", "a valid default");
}

function composerReasoningOptionLabel(
  option: Readonly<EchoInkPiReasoningOption>,
  language: "zh-CN" | "en" = "zh-CN"
): string {
  return labelFor(option.effort, language);
}

function composerReasoningCurrentValue(
  state: Readonly<ComposerReasoningState> | null,
  language: "zh-CN" | "en"
): string {
  if (!state?.supported || !state.enabled || state.effort === "none") {
    return conversationUiText(language, "关闭", "Off");
  }
  const option = state.enabledOptions.find(
    (candidate) => candidate.effort === state.effort
  );
  return !state.adjustable && option?.display === "toggle"
    ? conversationUiText(language, "模型默认", "Model default")
    : labelFor(state.effort, language);
}

function composerReasoningDisabledReason(
  state: Readonly<ComposerReasoningState> | null,
  language: "zh-CN" | "en"
): string {
  if (!state) return conversationUiText(language, "请先选择可用模型", "Choose an available model first");
  if (!state.supported) return conversationUiText(language, "当前模型不支持深度思考", "This model does not support reasoning");
  if (!state.enabled) return conversationUiText(language, "请先在模型设置中开启深度思考", "Enable reasoning in Model settings first");
  if (state.adjustable) return "";
  const option = state.enabledOptions.find(
    (candidate) => candidate.effort === state.effort
  );
  return option?.display === "toggle"
    ? conversationUiText(language, "当前模型只支持开启或关闭，思考强度由模型自动决定", "This model only supports on/off; it selects the reasoning effort automatically")
    : conversationUiText(language, "当前模型只有一个可用思考强度", "This model has only one available reasoning effort");
}

function saveComposerSettings(
  host: Pick<CodexComposerHost, "plugin">,
  label: string
): void {
  void host.plugin.saveSettings(true).catch((error) => {
    console.error("Codex composer defaults save failed", error);
    new Notice(host.plugin.settings.settingsLanguage === "en"
      ? `Could not save ${label}: ${error instanceof Error ? error.message : String(error)}`
      : `${label}保存失败：${error instanceof Error ? error.message : String(error)}`);
  });
}

export function onInputChanged(host: CodexComposerHost): void {
  host.skillMenuEl.removeClass("is-visible");
  closeResourcePanel(host, false);
  if (!host.inputEl.value.trim()) {
    clearPromptEnhanceReview(host.promptEnhanceReviewEl);
    const session = host.ensureSession();
    clearSelectedPiConversationDraft(host.plugin, session.id);
  }
  host.renderToolbar();
  const noteQuery = noteMentionQueryAtCursor(
    host.inputEl.value,
    host.inputEl.selectionStart
  );
  if (noteQuery) {
    setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
    renderNoteMentionAutocomplete(host);
    return;
  }
  closeComposerNoteMentionMenu(host.inputEl);
  const query = knowledgeCommandQueryForInput(host.inputEl.value);
  if (query === null) {
    setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
    return;
  }
  host.renderKnowledgeCommandMatches(query);
}

function renderNoteMentionAutocomplete(host: CodexComposerHost): void {
  const query = noteMentionQueryAtCursor(
    host.inputEl.value,
    host.inputEl.selectionStart
  );
  if (!query) {
    closeComposerNoteMentionMenu(host.inputEl);
    return;
  }
  const menu = composerNoteMentionMenuElement(host.inputEl);
  if (!menu) return;
  const results = searchNoteMentionCatalog(
    cachedComposerNoteMentionCatalog(
      host.inputEl,
      () => buildVaultNoteMentionCatalog(host.app)
    ),
    query.query
  );
  const select = (entry: typeof results[number]) => {
    const currentQuery = noteMentionQueryAtCursor(
      host.inputEl.value,
      host.inputEl.selectionStart
    );
    if (!currentQuery) return;
    addComposerNoteMentionSelection(host.inputEl, entry);
    const next = removeNoteMentionQuery(host.inputEl.value, currentQuery);
    host.inputEl.value = next.value;
    host.inputEl.setSelectionRange(next.cursor, next.cursor);
    closeComposerNoteMentionMenu(host.inputEl);
    host.renderAttachments();
    host.renderToolbar();
    host.inputEl.focus();
  };
  const render = () => {
    const state = composerNoteMentionMenuState(host.inputEl);
    renderComposerNoteMentionMenu(
      menu,
      host.inputEl,
      state,
      { onSelect: select },
      host.plugin.settings.settingsLanguage
    );
  };
  setComposerNoteMentionMenu(host.inputEl, {
    results,
    onSelect: select,
    onRender: render,
    onClose: () => hideComposerNoteMentionMenu(host.inputEl, menu)
  });
  render();
}

function composerNoteMentionMenuElement(input: HTMLTextAreaElement): HTMLElement | null {
  return input.parentElement?.querySelector<HTMLElement>(".codex-note-mention-menu") ?? null;
}

function hideComposerNoteMentionMenu(input: HTMLTextAreaElement, menu: HTMLElement): void {
  menu.empty();
  menu.removeClass("is-visible");
  menu.setAttribute("aria-hidden", "true");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", input.parentElement
    ?.querySelector<HTMLElement>(".codex-knowledge-command-menu")?.id ?? "");
  input.removeAttribute("aria-activedescendant");
}

export function renderSkillMatches(host: CodexComposerHost, query = "", loadedSkills?: EchoInkResource[]): void {
  renderSkillMatchesView(
    host.skillMenuEl,
    query,
    {
      language: host.plugin.settings.settingsLanguage,
      skills: enabledSkillsForComposerMenu(
        loadedSkills ?? host.currentEchoInkResourceCatalog()
      ),
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

export function enabledSkillsForComposerMenu(
  catalog: EchoInkResource[]
): EchoInkResource[] {
  return enabledSkillResources(catalog);
}

export function renderKnowledgeCommandMatches(
  host: CodexComposerHost,
  query: string,
  loadedSkills?: EchoInkResource[]
): void {
  renderKnowledgeCommandMatchesView(
    host.knowledgeCommandMenuEl,
    host.inputEl,
    query,
    {
      language: host.plugin.settings.settingsLanguage,
      skills: enabledSkillsForComposerMenu(
        loadedSkills ?? host.currentEchoInkResourceCatalog()
      ),
      selectedSkill: host.selectedSkill
    },
    {
      onFillCommand: (command) => fillKnowledgeBaseCommand(host, command),
      onSelectSkill: (skill) => {
        host.selectedSkill = skill;
        host.inputEl.value = removeTrailingSlashQuery(host.inputEl.value);
        clearPromptEnhanceReview(host.promptEnhanceReviewEl);
        setKnowledgeCommandMenuOpen(host.inputEl, host.knowledgeCommandMenuEl, false);
        host.renderAttachments();
        host.renderToolbar();
        host.inputEl.focus();
      }
    }
  );
  if (host.skillsRequested) return;
  host.skillsRequested = true;
  void host.plugin.ensureEchoInkSkillResourcesLoaded(true).then((skills) => {
    const currentQuery = knowledgeCommandQueryForInput(host.inputEl.value);
    if (currentQuery !== null) renderKnowledgeCommandMatches(host, currentQuery, skills);
  }).catch(() => undefined);
}

export async function stopTurnFromComposer(
  host: Pick<
    CodexComposerHost,
    "activeRunSessionId" | "plugin" | "running" | "stopTurn"
  >,
  session: Pick<StoredSession, "id">
): Promise<void> {
  if (
    host.running
    && host.activeRunSessionId
    && host.activeRunSessionId !== session.id
  ) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "另一个会话正在运行；当前会话不能停止它。",
      "Another conversation is running; this conversation cannot stop it."
    ));
    return;
  }
  await host.stopTurn();
}

export function removeTrailingSlashQuery(value: string): string {
  return value.replace(/(^|\s)\/[^\s/]*$/u, (_match, prefix: string) => prefix ? " " : "").replace(/\s+$/u, "");
}

export function hasComposerDraft(host: CodexComposerHost): boolean {
  return Boolean(
    host.inputEl?.value.trim()
    || host.attachments.length
    || composerNoteMentionSelections(host.inputEl).length
    || host.selectedSkill
  );
}

export function clearComposerDraft(host: CodexComposerHost): void {
  const session = host.ensureSession();
  clearSelectedPiConversationDraft(host.plugin, session.id);
  host.inputEl.value = "";
  clearPromptEnhanceReview(host.promptEnhanceReviewEl);
  closeComposerMenus(host);
  host.attachments = [];
  clearComposerNoteMentions(host.inputEl);
  host.selectedSkill = null;
}

export function composerStateForSession(host: CodexComposerHost, session: StoredSession): ComposerPrimaryActionState {
  const knowledgeManager = host.plugin.getKnowledgeSurfaceService();
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

export function requireQueueRecoveryForSession(host: CodexComposerHost, sessionId: string): void {
  host.turnQueue.requireSessionRecovery(sessionId);
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
  const view = contextUsageView(tokenUsage, session.contextLedger);
  host.contextEl.setCssProps({ "--codex-context-angle": `${view.angle}deg` });
  const tooltip = view.percent === null || view.effectiveInputBudget === null
    ? conversationUiText(host.plugin.settings.settingsLanguage, "暂未读取到上下文用量", "Context usage is not available yet")
    : host.plugin.settings.settingsLanguage === "en"
      ? `${view.percent}% · ${formatContextValue(view.totalTokens)} / ${formatContextValue(view.effectiveInputBudget)} context used`
      : `${view.percent}% · ${formatContextValue(view.totalTokens)} / ${formatContextValue(view.effectiveInputBudget)} 上下文已使用`;
  host.contextEl.setAttr("aria-label", tooltip);
  host.contextEl.setAttr("title", tooltip);
  host.contextEl.toggleClass("is-empty", view.percent === null);
  host.contextEl.toggleClass("is-warning", (view.percent ?? 0) >= 80);
  if (host.contextPanelOpen && host.contextPanelEl) {
    renderContextPanel(
      host.contextPanelEl,
      session.contextLedger,
      () => closeContextPopover(host, true),
      host.plugin.settings.settingsLanguage
    );
    host.contextPanelReposition?.();
  }
}

function formatContextValue(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}K`;
  return String(tokens);
}

function syncContextPopover(
  host: CodexComposerHost,
  ledger: StoredSession["contextLedger"]
): void {
  if (!host.contextPanelOpen) {
    host.contextPanelOpen = false;
    host.contextEl.setAttribute("aria-expanded", "false");
    return;
  }

  const doc = host.contextEl.ownerDocument;
  const win = doc.defaultView ?? window;
  const panelId = `codex-context-popover-${++contextPopoverId}`;
  const panel = doc.body.createDiv({
    cls: "codex-context-panel",
    attr: {
      id: panelId,
      role: "dialog",
      "aria-label": conversationUiText(host.plugin.settings.settingsLanguage, "上下文用量明细", "Context usage details"),
      tabindex: "-1"
    }
  });
  host.contextPanelEl = panel;
  host.contextEl.setAttribute("aria-expanded", "true");
  host.contextEl.setAttribute("aria-controls", panelId);
  renderContextPanel(
    panel,
    ledger,
    () => closeContextPopover(host, true),
    host.plugin.settings.settingsLanguage
  );

  const reposition = () => {
    if (!host.contextEl.isConnected || !panel.isConnected) {
      closeContextPopover(host, false);
      return;
    }
    const anchorRect = host.contextEl.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const placement = positionAnchoredMenu(
      anchorRect,
      panelRect,
      {
        width: doc.documentElement.clientWidth,
        height: doc.documentElement.clientHeight
      }
    );
    panel.setCssStyles({
      left: `${placement.left}px`,
      top: `${placement.top}px`,
      visibility: "visible"
    });
    panel.dataset.verticalSide = placement.verticalSide;
  };
  host.contextPanelReposition = reposition;

  const abortController = new AbortController();
  const eventOptions = { signal: abortController.signal };
  doc.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Node ? event.target : null;
    if (!target || panel.contains(target) || host.contextEl.contains(target)) return;
    closeContextPopover(host, false);
  }, eventOptions);
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !host.contextPanelOpen) return;
    event.preventDefault();
    event.stopPropagation();
    closeContextPopover(host, true);
  }, eventOptions);
  doc.addEventListener("scroll", reposition, { capture: true, signal: abortController.signal });
  win.addEventListener("resize", reposition, eventOptions);
  host.contextPanelCleanup = () => abortController.abort();
  reposition();
}

function closeContextPopover(host: CodexComposerHost, restoreFocus: boolean): void {
  if (!host.contextPanelOpen && !host.contextPanelEl) return;
  host.contextPanelOpen = false;
  disposeContextPopover(host);
  host.contextEl?.setAttribute("aria-expanded", "false");
  if (restoreFocus) host.contextEl?.focus();
}

export function disposeContextPopover(host: CodexComposerHost): void {
  host.contextPanelCleanup?.();
  host.contextPanelCleanup = null;
  host.contextPanelReposition = null;
  host.contextPanelEl?.remove();
  host.contextPanelEl = null;
  host.contextEl?.removeAttribute("aria-controls");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
