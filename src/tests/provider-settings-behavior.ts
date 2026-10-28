import { runCustomModelToolCallingTests } from "./custom-model-tool-calling";
import { runCustomToolCallingRuntimeTests } from "./pi-native/pi-native-conversation-runtime";
import { runProviderModelDiscoveryRegression } from "./provider-model-discovery-behavior";
import { runSettingsSaveResilienceTests } from "./settings-save-resilience";
import { emptyWorkspaceResourceSnapshot } from "../core/workspace-resources";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { PiTurnInteractionBroker } from "../plugin/pi-turn-interaction-broker";
import { todoCompletionStatistics } from "../home/todo-completions";
import { createOriginSelectHostFixture } from "./origin-obsidian-dom-shim";
import { mountSettingsEditor } from "../settings/inline-editor";
import * as assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Modal, Platform, TFile, TFolder, openTestModals, openTestNoticeMessages } from "obsidian";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ModelThinkingLevel,
  ProviderStreams,
  StreamOptions
} from "@earendil-works/pi-ai";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream
} from "@earendil-works/pi-ai";
import {
  isContextOverflow,
  isRetryableAssistantError,
  streamSimple
} from "@earendil-works/pi-ai/compat";
import {
  clampMaxTokensToContext
} from "@earendil-works/pi-ai/api/simple-options";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession
} from "@earendil-works/pi-coding-agent";
import {
  ANTHROPIC_MODELS
} from "@earendil-works/pi-ai/providers/anthropic.models";
import {
  DEEPSEEK_MODELS
} from "@earendil-works/pi-ai/providers/deepseek.models";
import {
  MOONSHOTAI_CN_MODELS
} from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import {
  OPENAI_CODEX_MODELS
} from "@earendil-works/pi-ai/providers/openai-codex.models";
import {
  OPENAI_MODELS
} from "@earendil-works/pi-ai/providers/openai.models";
import {
  QWEN_TOKEN_PLAN_CN_MODELS
} from "@earendil-works/pi-ai/providers/qwen-token-plan-cn.models";
import {
  ZAI_CODING_CN_MODELS
} from "@earendil-works/pi-ai/providers/zai-coding-cn.models";
import {
  activateApiProvider,
  activateApiProviderModel,
  apiProviderModelHadInvalidStoredReasoningEffort,
  applyApiProviderModelLimitsOverride,
  applyApiProviderModelPreset,
  createApiProviderConfig,
  createApiProviderModelConfig,
  DEFAULT_SETTINGS,
  normalizeSettingsData,
  providerConnectionLabel,
  removeApiProvider,
  type ApiProviderConfig,
  type ApiProviderModelConfig
} from "../settings/settings";
import CodexForObsidianPlugin from "../main";
import {
  API_PROVIDER_PRESETS,
  apiProviderConfiguredDisplayName,
  apiProviderRequestUrl,
  getApiProviderPreset,
  isQwenTokenPlanApiProviderUrl,
  normalizeApiProviderProtocol,
  QWEN_TOKEN_PLAN_API_BASE_URL
} from "../settings/provider-presets";
import {
  resolveEchoInkPiCatalogModel,
  resolveEchoInkPiReasoningCapabilities
} from "../settings/pi-model-catalog";
import {
  resolveComposerReasoningState
} from "../ui/composer-reasoning";
import {
  resolveKnowledgeMaintenanceSubmitSnapshot
} from "../plugin/knowledge-surface-service";
import { providerTooltipBaseUrl } from "../settings/provider-tooltip";
import {
  createObsidianProviderFetch,
  PiProviderConfigurationService,
  providerModelFetchForUrl,
  requestProviderModels,
  testProviderConnection,
  type PiProviderConfigurationDraft,
  type PiProviderConnectionTestResult,
  type PiProviderFetch,
  type PiProviderModelListResult
} from "../plugin/pi-provider-configuration-service";
import {
  createConfiguredPiProviderProtocolDispatcher,
  resolveConfiguredPiProviderTransportKind
} from "../plugin/configured-pi-provider-dispatcher";
import {
  createQwenTokenPlanOpenAICompletionsAdapter,
  type QwenTokenPlanProviderRequest
} from "../plugin/qwen-token-plan-provider-adapter";
import {
  createLoopbackOpenAICompletionsAdapter,
  type LoopbackProviderRequest
} from "../plugin/loopback-openai-provider-adapter";
import {
  classifyPiProviderConnectionFailure,
  createOpenAICodexSseAdapter,
  PiProviderProtocolDispatcher,
  PiProviderProtocolTransport,
} from "../harness/pi/pi-provider-protocol-adapter";
import { preventProviderRetryAfterPartial, providerFailureText } from "../harness/pi/provider-failure";
import { validProviderHistory } from "../harness/pi/provider-stream-codec";
import { estimateUsageInputTokens } from "../harness/usage/token-estimator";
import type { UsageRequestEvent } from "../harness/usage/usage-stream";
import {
  createPiProviderModelDefinition
} from "../harness/pi/production-pi-model-resolver";
import {
  createPiNativeControlledProvider,
  createPiNativeModelFromConfiguration
} from "../harness/pi-native/pi-native-controlled-provider";
import {
  ControlledVaultResourceLoader
} from "../harness/pi-native/controlled-resources";
import {
  PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER,
  PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
} from "../harness/pi-native/pi-document-context";
import {
  ProviderPreflightSession,
  providerPreflightApiKeyReady
} from "../settings/provider-preflight";
import { ProviderModelModal } from "../settings/provider-model-modal";
import { providerBrandSvg } from "../settings/provider-brand-icons";
import { settingsCopy } from "../settings/i18n";
import { CodexSettingTab } from "../settings/settings-tab";
import { DesktopKnowledgeSettings } from "../settings/desktop-knowledge-settings";
import { DesktopMemorySettings } from "../settings/desktop-memory-settings";
import { renderCompactAbout } from "../settings/about-section";
import { renderKnowledgeMaintenanceHistoryList, openKnowledgeMaintenancePath } from "../settings/knowledge-maintenance-history";
import { McpServerModal } from "../settings/mcp-server-modal";
import { MemoryCorrectionModal } from "../ui/modals";
import {
  ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES,
  ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION
} from "../knowledge-base/knowledge-maintenance-preferences";
import {
  createKnowledgeMaintenancePreferenceEditor
} from "../settings/knowledge-maintenance-preference-editor";
import {
  runHarnessV2PiObsidianSecretStorageTests
} from "./harness-v2/pi-obsidian-secret-storage";
import {
  runHarnessV2PiProviderSecurityTests
} from "./harness-v2/pi-provider-security";
import {
  runPiNativeControlledProviderTests
} from "./pi-native/pi-native-controlled-provider";
import {
  runApiProviderActivationServiceTests
} from "./api-provider-activation-service";
import {
  ApiProviderActivationService,
  ProductActivityGate
} from "../plugin/api-provider-activation-service";
import { CodexView } from "../ui/codex-view";
import { currentComposerProviderBrand } from "../ui/codex-view/composer-controller";
import { runEditorTranslationServiceTests } from "./editor-translation-service";
import { runEditorTranslationSelectionTests } from "./editor-translation-selection";
import {
  buildActiveEchoInkResourceCatalog,
  enabledSkillResources,
  mcpResourceEnablement
} from "../resources/registry";
import {
  loadMcpPanelView,
  renderMcpPanelView
} from "../ui/codex-view/mcp-panel";
import { currentTurnOptions } from "../ui/codex-view/workspace-controller";
import {
  EchoInkSettingsStore,
  ResourceMutationError,
  SettingsPersistenceError,
  restoreApiProviderSettings,
  settingsForDataSave,
  snapshotApiProviderSettings
} from "../plugin/settings-store";
import { EchoInkResourceCatalogService } from "../plugin/resource-catalog-service";
import { AgentIdentityModal } from "../ui/agent-identity-modal";
import { KnowledgeNotePickerModal } from "../settings/knowledge-note-picker-modal";
import {
  AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS,
  AGENT_AVATAR_SOURCE_MAX_BYTES,
  processAgentAvatar,
  validateAgentAvatarSvg,
  validateAvatarSourceSize,
  validateAvatarSourceType
} from "../ui/agent-avatar-processor";
import {
  AGENT_AVATAR_PRESETS,
  DEFAULT_AGENT_AVATAR_PRESET_ID,
  resolveAgentAvatarPresetAsset,
  resolveAgentAvatarUrl
} from "../ui/agent-avatar-presets";
import { AGENT_IDENTITY_STATE_SCHEMA } from "../harness/memory/agent-identity-model";
import {
  BUILTIN_SKILL_IDS,
  BUILTIN_SKILLS,
  getBuiltinSkillDefinition,
  renderBuiltinSkill
} from "../harness/resources/builtin-skills";
import type {
  BuiltinSkillRuntimeSnapshot
} from "../harness/resources/skill-runtime";
import {
  advanceEchoInkOnboardingTutorial,
  deriveEchoInkOnboardingTruth,
  dismissEchoInkOnboardingTutorial,
  ECHOINK_ONBOARDING_VERSION,
  echoInkOnboardingTab,
  isEmptyEchoInkPluginData,
  onboardingCoachmarkCopy,
  prepareEchoInkOnboardingTutorial,
  shouldAutoStartEchoInkOnboarding
} from "../settings/onboarding";
import { renderCodexHeader, updateCodexHeaderIdentity } from "../ui/codex-view/header";
import { mountEchoInkOnboardingCoachmark } from "../ui/onboarding-coachmark";
import { KNOWLEDGE_INITIALIZATION_ROOTS } from "../knowledge-base/initializer";
import {
  logoutOpenAICodexAfterRuntimeSuspension,
  OpenAICodexOAuthService,
  OpenAICodexSettingsCredentialStore
} from "../plugin/openai-codex-oauth-service";
import { resolvePiProductionSkillById } from "../plugin/pi-production-runtime-composition";
import { runEnglishDiaryProviderTests } from "./english-diary-provider";

export async function runProviderSettingsBehaviorTests(): Promise<void> {
  await runSettingsSaveResilienceTests();
  await runEnglishDiaryProviderTests(installProviderModalDomFixture);
  await runSettingsWindowRefreshTest();
  await assertInlineEditorAsyncRetirement();
  await assertReviewFolderInlineLifecycle();
  assertSettingsV53MigrationContract();
  await assertJournalDirectorySettingsUi();
  assertPiReasoningCapabilityContract();
  assertKnowledgeMaintenanceSubmitSnapshotContract();
  await assertPiReasoningPayloadContract();
  assertOnboardingTruthContract();
  assertFiveStepOnboardingEntrypoints();
  assertCodexHeaderIdentityContract();
  await assertOnboardingCoachmarkAccessibilityContract();
  await assertOnboardingDoesNotLockSettingsNavigation();
  await assertManualOnboardingReopenIsRemoved();
  await assertRetiredSettingsRewritePersistence();
  assertProviderScopedRollbackPreservesConcurrentSettings();
  await assertPersistedProviderRollbackPreservesQueuedSettingsSave();
  await assertSettingsPersistenceReadbackOutcomes();
  assertConversationSettingsDiscardMessageBodies();
  await assertProviderApiKeyPersistenceLifecycle();
  await assertOpenAICodexCredentialStoreContract();
  await assertOpenAICodexLogoutSuspendsRuntime();
  await runApiProviderActivationServiceTests();
  await assertProviderActivationMainTransactionContract();
  assertAllOpenComposersSynchronizeAfterActivation();
  await runEditorTranslationServiceTests();
  runEditorTranslationSelectionTests();
  await assertProviderTextGenerationCompletionContract();
  await assertCodexConnectionTestContract();
  assertPresetRequestMappings();
  assertAnthropicProviderContract();
  assertQwenProviderContract();
  await assertProviderOutputLimitContract();
  await assertQwenTokenPlanTransportContract();
  await assertPiAgentSessionPartialAwareRetryContract();
  await assertProviderModelDiscoveryRequestContract();
  assertCustomProtocolContract();
  assertOpenAICodexSseAdapterContract();
  await assertProviderRequestLimitDispatchContract();
  await assertProtocolPayloadLimitContract();
  await assertSpecialProviderPayloadLimitContract();
  await assertAnthropicDocumentTransportContract();
  await assertProviderAuthResolutionFailureContract();
  assertProviderTooltipBehavior();
  assertSavedModelLifecycle();
  assertNewProductGenerationKeepsConfigurationButDropsLegacyHistory();
  await assertKnowledgeSettingsDetailRetiresLegacyControls();
  await assertKnowledgeInitNotePickerModalContract();
  await assertAnimatedSettingsTabIcons();
  await assertSettingsAccessibleNamesAndOverflow();
  await assertDesktopModelAndMcpFinish();
  await assertMemoryCorrectionModalContract();
  assertMemoryComposerVisualCssContract();
  await assertMcpPanelUsesTurnResourceTruth();
  await assertBuiltinSkillPresetLabels();
  await assertBuiltinSkillEditorLifecycle();
  await assertDefaultSkillProductionAvailabilityGate();
  await assertRollbackSafeResourceCatalogKeepsBuiltinFileState();
  await assertSkillToggleNotCommittedRestoresAuthoritativeUi();
  await assertResourceScanErrorsClearAcrossTabs();
  assertProviderBadgeReflowCssContract();
  assertProviderAdvancedSettingsCssContract();
  await assertSavedBindingPreflightLifecycle();
  await assertProviderPickerGroupingAndFiltering();
  await assertOpenAICodexModalLifecycle();
  await assertFreshCustomModelDiscoveryLifecycle();
  await assertProviderLimitOverrideRoundTrip();
  await assertProviderModelModalPreflightLifecycle();
  await assertProviderApiKeyEditLifecycle();
  await assertProviderModalModelAccessibleNameIncludesValue();
  assertProviderModelReasoningOverrideBoundary();
  await assertProviderModelModalCloseCancelsPendingPreflight();
  await assertMcpModalFieldAccessibility();
  await runHarnessV2PiObsidianSecretStorageTests();
  await runHarnessV2PiProviderSecurityTests();
  await runPiNativeControlledProviderTests();
  await assertPersonalMemoryDtoAndRegistryIdentity();
  assertCustomWelcomeContract();
  assertAboutGitHubActionsContract();
  await assertIdentityModalNameValidation();
  await assertAvatarPresetCatalogBehavior();
  await assertAvatarProcessorContract();
}

export async function runBuiltinSkillSettingsBehaviorTests(): Promise<void> {
  await assertBuiltinSkillPresetLabels();
  await assertBuiltinSkillEditorLifecycle();
  await assertRollbackSafeResourceCatalogKeepsBuiltinFileState();
  console.log("PASS settings: built-in Skill labels, editing, restore, and rollback state");
}

function replaceProviderModels(
  provider: ApiProviderConfig,
  ...modelIds: string[]
): void {
  provider.models = modelIds.map((modelId) =>
    createApiProviderModelConfig(provider.providerId, modelId)
  );
  provider.defaultModelId = provider.models[0]?.id ?? "";
}

function primaryProviderModel(provider: ApiProviderConfig): ApiProviderModelConfig {
  const model = provider.models.find(
    (candidate) => candidate.id === provider.defaultModelId
  );
  assert.ok(model);
  return model;
}

async function assertProviderActivationMainTransactionContract(): Promise<void> {
  const provider = createApiProviderConfig("deepseek", "transaction-provider");
  provider.apiKey = "fixture-key";
  const alternateId = API_PROVIDER_PRESETS.find(
    (candidate) => candidate.id === "deepseek"
  )?.models[1]?.id;
  assert.ok(alternateId);
  provider.models.push(createApiProviderModelConfig("deepseek", alternateId));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.apiProviders = [provider];
  activateApiProvider(settings, provider);
  const events: string[] = [];
  const plugin = Object.create(
    CodexForObsidianPlugin.prototype
  ) as CodexForObsidianPlugin & Record<string, any>;
  plugin.settings = settings;
  plugin.piRunConversations = new Map();
  plugin.productActivity = new ProductActivityGate();
  plugin.apiProviderActivation = new ApiProviderActivationService();
  plugin.piRuntimeBundle = null;
  plugin.piRuntimeFlight = null;
  plugin.piActivatedConversationId = null;
  plugin.cancelAllPiConversationActivations = async () => {
    events.push("cancel-activations");
  };
  let persisted = snapshotApiProviderSettings(settings);
  plugin.getSettingsStore = () => ({
    readPersistedApiProviderSettingsSnapshot: async () => {
      events.push("read-persisted");
      return structuredClone(persisted);
    },
    restorePersistedApiProviderSettingsSnapshot: async (
      snapshot: typeof persisted
    ) => {
      events.push("restore-persisted");
      persisted = structuredClone(snapshot);
    }
  });
  plugin.saveSettings = async () => {
    events.push("persist-candidate");
    persisted = snapshotApiProviderSettings(plugin.settings);
  };
  plugin.applyComposerDefaultsToView = () => {
    events.push("sync-composers");
  };

  plugin.piRunConversations.set("conversation-busy", "run-busy");
  await assert.rejects(
    plugin.activateApiProviderSettings(() => undefined),
    /正在回答/u
  );
  assert.deepEqual(events, [], "busy must be checked before activation cancellation");
  plugin.piRunConversations.clear();

  await assert.rejects(plugin.activateApiProviderSettings((candidate) => {
    const model = candidate.apiProviders[0]?.models[0];
    assert.ok(model);
    model.contextWindow = 1_024;
    model.modelMaxTokens = 2_048;
    model.maxOutputTokens = 2_048;
  }), /Context|metadata/u);
  assert.deepEqual(events, [], "invalid candidate must fail before cancellation or persistence");
  assert.equal(plugin.settings.defaultModel, provider.defaultModelId);

  await plugin.activateApiProviderSettings((candidate) => {
    const target = candidate.apiProviders[0];
    assert.ok(target);
    activateApiProviderModel(candidate, target, alternateId);
  }, "preserve");
  assert.deepEqual(events, [
    "cancel-activations",
    "read-persisted",
    "persist-candidate",
    "sync-composers"
  ]);
  assert.equal(plugin.settings.defaultModel, alternateId);
  assert.equal(persisted.defaultModel, alternateId);
}

function assertAllOpenComposersSynchronizeAfterActivation(): void {
  const synchronized: string[] = [];
  const first = Object.create(CodexView.prototype) as CodexView;
  const second = Object.create(CodexView.prototype) as CodexView;
  first.applySavedComposerDefaults = () => { synchronized.push("first"); };
  second.applySavedComposerDefaults = () => { synchronized.push("second"); };
  CodexForObsidianPlugin.prototype.applyComposerDefaultsToView.call({
    app: {
      workspace: {
        getLeavesOfType: () => [
          { view: first },
          { view: { applySavedComposerDefaults: () => synchronized.push("other") } },
          { view: second }
        ]
      }
    }
  });
  assert.deepEqual(synchronized, ["first", "second"]);
}

async function assertAnimatedSettingsTabIcons(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "providers";
  const plugin = withSettingsTabDefaults({
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getEchoInkPersonalMemoryState: async () => createIdentityFixtureState({ revision: 0 }),
    listPiConversations: async () => [],
    setPiConversationStatus: async () => undefined,
    getCodexView: () => null
  });
  const tab = new CodexSettingTab(plugin as never);
  tab.display();

  const expected = [
    ["general", "settings"],
    ["layout", "blocks"],
    ["providers", "key-round"],
    ["resources", "layout-list"],
    ["knowledgeBase", "book-open-check"],
    ["review", "clipboard-check"],
    ["todos", "list-todo"],
    ["account", "feather"]
  ] as const;
  const icons = tab.containerEl.querySelectorAll<ProviderModalTestElement>(
    ".codex-settings-tab-icon"
  );
  assert.equal(icons.length, expected.length);
  expected.forEach(([tabId, iconName], index) => {
    assert.equal(
      icons[index]?.parentElement?.getAttribute("data-settings-tab"),
      tabId
    );
    assert.equal(icons[index]?.getAttribute("data-animated-icon"), iconName);
    assert.equal(icons[index]?.hasClass("is-animating"), false);
    const svg = icons[index]?.querySelector("svg");
    assert.ok(svg, `${iconName} renders its own layered SVG`);
    assert.equal(svg.getAttribute("data-animateicons-source"), "lucide");
    assert.equal(svg.getAttribute("data-animateicons-icon"), iconName);
  });
  const iconFor = (tabId: string) => tab.containerEl
    .querySelector(`[data-settings-tab="${tabId}"]`)
    ?.querySelector<ProviderModalTestElement>(".codex-settings-tab-icon");
  assert.equal(iconFor("general")?.querySelectorAll('[data-part="settings-spark"]').length, 5);
  assert.ok(iconFor("general")?.querySelector('[data-part="settings-gear-draw"]'));
  assert.ok(iconFor("general")?.querySelector('[data-part="settings-core-draw"]'));
  assert.ok(iconFor("providers")?.querySelector('[data-part="key-path"]'));
  assert.ok(iconFor("providers")?.querySelector('[data-part="key-bite"]'));
  assert.ok(iconFor("providers")?.querySelector('[data-part="key-head"]'));
  assert.equal(iconFor("resources")?.querySelectorAll('[data-part="layout-box"]').length, 2);
  assert.equal(iconFor("resources")?.querySelectorAll('[data-part="layout-line"]').length, 4);
  assert.ok(iconFor("knowledgeBase")?.querySelector('[data-part="book-spine"]'));
  assert.ok(iconFor("knowledgeBase")?.querySelector('[data-part="book-body"]'));
  assert.ok(iconFor("knowledgeBase")?.querySelector('[data-part="book-check"]'));
  assert.ok(iconFor("review")?.querySelector('[data-part="clipboard-clip"]'));
  assert.ok(iconFor("review")?.querySelector('[data-part="clipboard-body"]'));
  assert.ok(iconFor("review")?.querySelector('[data-part="clipboard-check"]'));

  const providers = tab.containerEl.querySelector<ProviderModalTestElement>(
    '[data-settings-tab="providers"]'
  );
  assert.ok(providers);
  providers.fireEvent("keydown", { key: "End" });
  await flushProviderModalTasks();

  const review = tab.containerEl.querySelector<ProviderModalTestElement>(
    '[data-settings-tab="account"]'
  );
  assert.equal(review?.getAttribute("aria-selected"), "true");
  assert.equal(review?.getAttribute("tabindex"), "0");
  assert.equal(
    review?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"),
    false,
    "the icon waits for the bookmark to finish rising"
  );
  review?.fireEvent("transitionend", { propertyName: "background-color" });
  assert.equal(review?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"), false);
  review?.fireEvent("transitionend", { propertyName: "transform" });
  assert.equal(
    review?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"),
    true
  );

  const mutableTab = tab as unknown as {
    renderSettingsContent(): void;
    settingsTabIconAnimation: { tabId: string; startedAtMs: number } | null;
  };
  assert.ok(mutableTab.settingsTabIconAnimation);
  mutableTab.settingsTabIconAnimation.startedAtMs = Date.now() - 400;
  mutableTab.renderSettingsContent();
  const continuedIcon = tab.containerEl.querySelector('[data-settings-tab="account"]')
    ?.querySelector<ProviderModalTestElement>(".codex-settings-tab-icon");
  assert.equal(continuedIcon?.hasClass("is-animating"), true);
  assert.ok(
    Number.parseInt(
      continuedIcon?.style.getPropertyValue("--echoink-tab-icon-delay") ?? "0",
      10
    ) <= -350,
    "same-tab rerenders continue the original timeline instead of replaying it"
  );
  mutableTab.settingsTabIconAnimation = {
    tabId: "account",
    startedAtMs: Date.now() - 1_300
  };
  mutableTab.renderSettingsContent();
  assert.equal(
    tab.containerEl.querySelector('[data-settings-tab="account"]')
      ?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"),
    false,
    "the tab icon animation ends after its bounded window"
  );

  tab.display();
  const providersAgain = tab.containerEl.querySelector<ProviderModalTestElement>(
    '[data-settings-tab="providers"]'
  );
  assert.ok(providersAgain);
  providersAgain.fireEvent("pointerdown");
  providersAgain.click();
  await flushProviderModalTasks();
  const selectedProvider = tab.containerEl.querySelector<ProviderModalTestElement>('[data-settings-tab="providers"]');
  assert.equal(selectedProvider?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"), false);
  selectedProvider?.fireEvent("transitionend", { propertyName: "transform" });
  assert.equal(
    tab.containerEl.querySelector('[data-settings-tab="providers"]')
      ?.querySelector(".codex-settings-tab-icon")?.hasClass("is-animating"),
    true,
    "pointer tab switches animate the newly selected icon once"
  );

  tab.display();
  providerModalTestDocument.prefersReducedMotion = true;
  try {
    tab.containerEl.querySelector<ProviderModalTestElement>('[data-settings-tab="todos"]')!.click();
    await flushProviderModalTasks();
    assert.equal(mutableTab.settingsTabIconAnimation?.tabId, "todos",
      "reduced motion completes selection without waiting for transitionend");
  } finally {
    providerModalTestDocument.prefersReducedMotion = false;
  }

  const css = readFileSync(path.resolve("styles.css"), "utf8");
  for (const keyframe of [
    "settings-motion",
    "settings-gear-draw",
    "settings-core-draw",
    "settings-spark",
    "key-motion",
    "key-path",
    "key-bite",
    "key-head",
    "layout-box",
    "layout-line",
    "book-motion",
    "book-spine",
    "book-body",
    "book-check",
    "clipboard-body",
    "clipboard-clip",
    "clipboard-check"
  ]) {
    assert.match(css, new RegExp(`@keyframes echoink-tab-icon-${keyframe}\\b`, "u"));
  }
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.codex-settings-tab-icon\.is-animating svg[\s\S]*animation:\s*none !important;/u
  );
  tab.hide();
}

async function assertMemoryCorrectionModalContract(): Promise<void> {
  installProviderModalDomFixture();
  const generations = [
    deferred<Readonly<{ title: string; content: string; recallWhen: string }>>(),
    deferred<Readonly<{ title: string; content: string; recallWhen: string }>>(),
    deferred<Readonly<{ title: string; content: string; recallWhen: string }>>()
  ];
  const save = deferred<void>();
  const generationSignals: AbortSignal[] = [];
  let generationCalls = 0;
  let saveCalls = 0;
  let result: "saved" | "cancelled" | "conflict" | undefined;
  const modal = new MemoryCorrectionModal(
    new App(),
    {
      memoryType: "事实",
      title: "当前标题",
      content: "当前内容只能查看",
      recallWhen: "讨论验收边界时"
    },
    "zh-CN",
    {
      generate: async (_correction, signal) => {
        generationSignals.push(signal);
        return await generations[generationCalls++]!.promise;
      },
      save: async () => {
        saveCalls += 1;
        await save.promise;
      }
    },
    (value) => {
      result = value;
    }
  );
  modal.open();
  const title = modal.contentEl.querySelector("h2");
  assert.equal(title?.textContent, "修正事实记忆");
  assert.doesNotMatch(title?.textContent ?? "", /当前标题/u);
  assert.match(modal.contentEl.textContent, /说明哪里不准确，以及正确内容是什么/u);
  assert.ok(modal.contentEl.querySelector(".echoink-memory-correction-current"));
  assert.match(modal.contentEl.textContent, /当前标题/u);
  assert.match(modal.contentEl.textContent, /当前内容只能查看/u);
  assert.match(modal.contentEl.textContent, /讨论验收边界时/u);
  assert.match(modal.contentEl.textContent, /何时可能想起/u);
  assert.equal(modal.contentEl.querySelectorAll("input").length, 0);

  const textarea = modal.contentEl.querySelector<ProviderModalTestElement>(
    'textarea[aria-label="修正说明"]'
  );
  assert.ok(textarea);
  assert.equal(textarea.getAttribute("rows"), "7");
  const correct = Array.from(modal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "生成预览");
  const saveButton = Array.from(modal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "确认保存");
  assert.ok(correct);
  assert.ok(saveButton);
  assert.equal(correct.disabled, true);
  assert.equal(saveButton.disabled, true);

  textarea.value = "第一行纠正\n第二行补充";
  textarea.oninput?.();
  assert.equal(correct.disabled, false);
  correct.click();
  assert.equal(textarea.disabled, true);
  assert.equal(correct.textContent, "停止");
  assert.ok(correct.querySelector(".echoink-memory-correction-spinner"));
  assert.equal(saveButton.disabled, true);
  assert.equal(generationSignals.length, 1);

  correct.click();
  assert.equal(generationSignals[0]?.aborted, true);
  assert.equal(textarea.value, "第一行纠正\n第二行补充");
  assert.equal(textarea.disabled, false);
  assert.equal(correct.textContent, "生成预览");
  generations[0]!.resolve({
    title: "迟到标题",
    content: "迟到内容",
    recallWhen: "迟到召回"
  });
  await flushProviderModalTasks();
  assert.equal(saveButton.disabled, true);
  assert.equal(
    modal.contentEl.querySelector(".echoink-memory-correction-preview")
      ?.hasClass("is-hidden"),
    true
  );

  correct.click();
  generations[1]!.resolve({
    title: "修正标题",
    content: "修正正文",
    recallWhen: "需要核对时"
  });
  await flushProviderModalTasks();
  const preview = modal.contentEl.querySelector(
    ".echoink-memory-correction-preview"
  );
  assert.equal(preview?.hasClass("is-hidden"), false);
  assert.match(preview?.textContent ?? "", /修正标题/u);
  assert.match(preview?.textContent ?? "", /修正正文/u);
  assert.match(preview?.textContent ?? "", /需要核对时/u);
  assert.equal(saveButton.disabled, false);

  textarea.value = "再次调整";
  textarea.oninput?.();
  assert.equal(saveButton.disabled, true);
  assert.equal(preview?.hasClass("is-hidden"), true);

  correct.click();
  generations[2]!.resolve({
    title: "最终标题",
    content: "最终正文",
    recallWhen: "最终召回"
  });
  await flushProviderModalTasks();
  assert.equal(saveButton.disabled, false);
  saveButton.click();
  saveButton.click();
  assert.equal(saveCalls, 1);
  assert.equal(saveButton.disabled, true);
  save.resolve();
  await flushProviderModalTasks();
  assert.equal(result, "saved");

  const closeGeneration = deferred<Readonly<{
    title: string;
    content: string;
    recallWhen: string;
  }>>();
  let closeSignal: AbortSignal | undefined;
  let cancelled: "saved" | "cancelled" | "conflict" | undefined;
  const cancelledModal = new MemoryCorrectionModal(
    new App(),
    {
      memoryType: "事实",
      title: "标题",
      content: "内容",
      recallWhen: "情境"
    },
    "zh-CN",
    {
      generate: async (_correction, signal) => {
        closeSignal = signal;
        return await closeGeneration.promise;
      },
      save: async () => undefined
    },
    (value) => {
      cancelled = value;
    }
  );
  cancelledModal.open();
  const closeTextarea = cancelledModal.contentEl.querySelector<ProviderModalTestElement>(
    'textarea[aria-label="修正说明"]'
  );
  const closeCorrect = Array.from(cancelledModal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "生成预览");
  assert.ok(closeTextarea);
  assert.ok(closeCorrect);
  closeTextarea.value = "关闭时停止";
  closeTextarea.oninput?.();
  closeCorrect.click();
  cancelledModal.close();
  assert.equal(closeSignal?.aborted, true);
  assert.equal(cancelled, "cancelled");
  closeGeneration.resolve({
    title: "关闭后的迟到标题",
    content: "关闭后的迟到内容",
    recallWhen: "关闭后的迟到召回"
  });
  await flushProviderModalTasks();
  assert.equal(cancelled, "cancelled");
}

function assertMemoryComposerVisualCssContract(): void {
  const css = readFileSync(path.resolve("styles.css"), "utf8");
  // Geometry and scoped overrides may occupy separate cascade rules.
  const blocks = (pattern: RegExp): string => Array.from(css.matchAll(new RegExp(pattern.source, "gu")), match => match[1]).join("\n");
  const currentRule = css.match(
    /\.echoink-memory-correction-current\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const previewRule = css.match(
    /\.echoink-memory-correction-preview\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const hiddenPreviewRule = css.match(
    /\.echoink-memory-correction-preview\.is-hidden\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const disabledSaveRule = css.match(
    /\.echoink-memory-correction-actions button\.mod-cta:disabled\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const sendButtonRule = blocks(
    /\.codex-composer-send-button\.codex-send-button\s*\{([^}]*)\}/u
  );
  const sendIconRule = css.match(
    /\.codex-composer-send-icon-wrap svg,\s*\.codex-composer-send-button \.echoink-animate-icon-send-horizontal,\s*\.codex-composer-send-button \.echoink-animate-icon-circle-stop\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  const stopButtonRule = blocks(
    /\.codex-composer-send-button\.codex-send-button\.is-stop-action\s*\{([^}]*)\}/u
  );
  const permissionKeyboardFocusRule = blocks(
    /\.codex-permission-control \.codex-composer-native-select\.codex-select:is\(:focus, :focus-visible\)\s*\{([^}]*)\}/u
  );

  assert.match(currentRule, /background:\s*var\(--background-secondary\);/u);
  assert.match(previewRule, /--echoink-memory-preview-cyan:\s*#70d7df;/u);
  assert.match(
    previewRule,
    /border-color:\s*color-mix\(\s*in srgb,\s*var\(--echoink-memory-preview-cyan\)\s*62%,\s*var\(--background-modifier-border\)\s*\);/u
  );
  assert.match(
    previewRule,
    /background:\s*color-mix\(\s*in srgb,\s*var\(--echoink-memory-preview-cyan\)\s*18%,\s*var\(--background-primary\)\s*\);/u
  );
  assert.match(hiddenPreviewRule, /display:\s*none;/u);
  assert.doesNotMatch(previewRule, /interactive-accent/u);
  assert.match(disabledSaveRule, /color:\s*var\(--text-faint\);/u);
  assert.match(
    disabledSaveRule,
    /background:\s*var\(--background-modifier-border\)\s*!important;/u
  );
  assert.match(disabledSaveRule, /cursor:\s*not-allowed;/u);
  assert.match(sendButtonRule, /width:\s*34px;/u);
  assert.match(sendButtonRule, /height:\s*34px;/u);
  assert.match(sendButtonRule, /flex:\s*0 0 34px;/u);
  assert.match(sendButtonRule, /color:\s*var\(--text-normal\);/u);
  assert.match(sendButtonRule, /box-shadow:\s*none;/u);
  assert.doesNotMatch(sendButtonRule, /interactive-accent|text-on-accent/u);
  assert.match(sendIconRule, /width:\s*20px;/u);
  assert.match(sendIconRule, /height:\s*20px;/u);
  assert.match(stopButtonRule, /color:\s*var\(--text-normal\);/u);
  assert.match(stopButtonRule, /box-shadow:\s*none;/u);
  assert.doesNotMatch(stopButtonRule, /text-error|status-danger/u);
  assert.match(permissionKeyboardFocusRule, /outline:\s*none;/u);
  assert.match(permissionKeyboardFocusRule, /border:\s*0;/u);
  assert.match(permissionKeyboardFocusRule, /box-shadow:\s*none;/u);
  assert.doesNotMatch(permissionKeyboardFocusRule, /interactive-accent|currentColor/u);
  assert.doesNotMatch(
    css,
    /\.codex-permission-control:focus-within\s*\{[^}]*outline:\s*2px solid currentColor/u,
    "pointer-opened native permission menus must not leave a yellow focus ring behind"
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*no-preference\)[\s\S]*?\.echoink-animate-icon-host\.is-send-horizontal-icon:is\(:hover, :focus-visible\)[\s\S]*?\.echoink-animate-icon-send-horizontal\s*\{[\s\S]*?1400ms ease-in-out/u,
    "the ordinary send action uses the pinned AnimateIcons send-horizontal timing"
  );
  assert.match(
    css,
    /\.echoink-animate-icon-host\.is-circle-stop-icon:is\(:hover, :focus-visible\)[\s\S]*?\.echoink-animate-circle-stop-ring/u,
    "the stop action uses the pinned AnimateIcons circle-stop motion"
  );
  assert.doesNotMatch(css, /codex-composer-send-icon-confirm/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none\s*!important/u);
}

async function assertProviderTextGenerationCompletionContract(): Promise<void> {
  const draft: PiProviderConfigurationDraft = {
    providerSettingsId: "translation-provider",
    providerId: "deepseek",
    runtimeProviderId: "deepseek",
    apiProtocol: "openai-completions",
    authMode: "api-key",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-chat",
    apiKey: "fixture-key",
    toolCalling: false,
    imageInput: true,
    reasoning: true,
    contextWindow: 96_000,
    modelMaxTokens: 12_000,
    maxOutputTokens: 4_000
  };
  const host = {
    app: new App(),
    settings: structuredClone(DEFAULT_SETTINGS),
    getVaultPath: () => "/fixture-vault"
  };
  let nextResult: (signal: AbortSignal) => Promise<AssistantMessage> = async () =>
    providerTextMessage("stop", "\n  - **Hello**\n\n");
  let capturedRequest: any = null;
  const dispatcher = {
    stream: (request: { options: { signal?: AbortSignal } }) => {
      capturedRequest = request;
      return {
        result: async () => await nextResult(request.options.signal ?? new AbortController().signal)
      };
    }
  } as unknown as Pick<PiProviderProtocolDispatcher, "stream">;
  const service = new PiProviderConfigurationService(host as never, {
    textGenerationDispatcher: dispatcher
  });
  const input = {
    draft,
    systemPrompt: "Translate.",
    userPrompt: "翻译。",
    timeoutMs: 1_000,
    maxTokens: 10_000
  };
  let writebackAttempts = 0;
  const generateAndWriteBack = async (): Promise<void> => {
    await service.generateText(input);
    writebackAttempts += 1;
  };

  assert.equal(
    await service.generateText(input),
    "\n  - **Hello**\n\n"
  );
  assert.deepEqual(capturedRequest?.model.input, ["text", "image"]);
  assert.equal(capturedRequest?.model.reasoning, true);
  assert.equal(capturedRequest?.model.contextWindow, 96_000);
  assert.equal(capturedRequest?.model.maxTokens, 12_000);
  assert.equal(capturedRequest?.options.maxTokens, 4_000);

  nextResult = async () => providerTextMessage("stop", " \n\t ");
  await assert.rejects(
    generateAndWriteBack(),
    /provider_text_generation_failed/u
  );

  for (const stopReason of ["length", "toolUse", "error", "aborted"] as const) {
    nextResult = async () => providerTextMessage(
      stopReason,
      `partial-${stopReason}`
    );
    await assert.rejects(
      generateAndWriteBack(),
      /provider_text_generation_failed/u
    );
  }

  nextResult = async (signal) => await new Promise<AssistantMessage>((resolve) => {
    signal.addEventListener("abort", () => {
      resolve(providerTextMessage("stop", "partial-after-timeout"));
    }, { once: true });
  });
  await assert.rejects(
    generateAndWriteBack(),
    /provider_text_generation_timeout/u
  );
  assert.equal(writebackAttempts, 0);

  const externalController = new AbortController();
  let providerSignal: AbortSignal | undefined;
  nextResult = async (signal) => {
    providerSignal = signal;
    return await new Promise<AssistantMessage>((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(providerTextMessage("stop", "partial-after-user-stop"));
      }, { once: true });
    });
  };
  const externallyCancelled = service.generateText({
    ...input,
    signal: externalController.signal
  });
  await flushProviderModalTasks();
  externalController.abort();
  await assert.rejects(
    externallyCancelled,
    /provider_text_generation_aborted/u
  );
  assert.equal(providerSignal?.aborted, true);
  assert.equal(writebackAttempts, 0);
}

async function assertCodexConnectionTestContract(): Promise<void> {
  const partial = providerTextMessage("error", "已收到的内容");
  partial.errorMessage = preventProviderRetryAfterPartial("provider_request_timeout", partial);
  assert.equal(isRetryableAssistantError(partial), false, "timeout must not restart a turn after partial output");
  assert.match(providerFailureText(partial.errorMessage) ?? "", /超时/u);
  assert.equal(classifyPiProviderConnectionFailure(400, "Unsupported parameter: temperature"), "request");
  assert.equal(classifyPiProviderConnectionFailure(400, "The model is not supported when using Codex with a ChatGPT account"), "model");
  assert.equal(classifyPiProviderConnectionFailure(200, "You have hit your ChatGPT usage limit"), "rate_limit");
  assert.notEqual(providerFailureText("provider_http_failed"), providerFailureText("provider_protocol_mismatch"));
  const draft: PiProviderConfigurationDraft = {
    ...providerModelDiscoveryDraft("openai-completions"),
    providerId: "openai-codex",
    runtimeProviderId: "openai-codex",
    apiProtocol: "openai-codex-responses",
    authMode: "oauth",
    baseUrl: "https://chatgpt.com/backend-api",
    modelId: "gpt-5.6-sol",
    reasoning: true
  };
  const host = { settings: structuredClone(DEFAULT_SETTINGS) };
  let capturedOptions: (StreamOptions & { reasoningEffort?: string }) | undefined;
  let requests = 0;
  let nextResult = async (_signal?: AbortSignal): Promise<AssistantMessage> =>
    providerTextMessage("stop", "OK");
  const run: ProviderStreams["stream"] = (model, context, options) => {
    requests++;
    capturedOptions = options;
    assert.equal(context.messages.length, 1);
    assert.deepEqual(context.tools, []);
    const output = createAssistantMessageEventStream();
    void (async () => {
      await options?.onResponse?.({
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
      output.push({ type: "start", partial: fixtureAssistantMessage(model) });
      const message = await nextResult(options?.signal);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        output.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        output.push({ type: "done", reason: message.stopReason, message });
      }
    })();
    return output;
  };
  const adapters = {
    "openai-codex-responses": { stream: run, streamSimple: run },
    "openai-completions": { stream: run, streamSimple: run }
  };
  const service = new PiProviderConfigurationService(host, {
    adapters,
    resolveOAuthAccessToken: async () => "fixture-codex-token"
  });
  const pendingAnswer = deferred<AssistantMessage>();
  nextResult = async () => await pendingAnswer.promise;
  let finished = false;
  const pending = service.testConnection(draft).then((result) => {
    finished = true;
    return result;
  });
  await flushProviderModalTasks();
  assert.equal(finished, false, "HTTP 200 and a started response are not a completed connection test");
  assert.equal(capturedOptions?.timeoutMs, 60_000);
  assert.equal(capturedOptions?.reasoningEffort, "low");
  assert.equal(capturedOptions?.maxTokens, 32);
  pendingAnswer.resolve(providerTextMessage("stop", "OK"));
  assert.deepEqual(await pending, { status: "available" });

  nextResult = async () => providerTextMessage("stop", "OK");
  assert.deepEqual(await service.testConnection({
    ...providerModelDiscoveryDraft("openai-completions"),
    modelId: "fixture-model",
    apiKey: "fixture-key"
  }), { status: "available" });
  assert.equal(capturedOptions?.timeoutMs, 10_000);
  assert.equal(capturedOptions?.reasoningEffort, undefined);

  for (const stopReason of ["length", "toolUse", "error", "aborted", "stop"] as const) {
    nextResult = async () => providerTextMessage(
      stopReason,
      stopReason === "stop" ? " \n " : "partial answer"
    );
    assert.equal((await service.testConnection(draft)).status, "failed");
  }

  const limited = new PiProviderConfigurationService(host, {
    adapters,
    resolveOAuthAccessToken: async () => "fixture-codex-token",
    timeoutMs: 5
  });
  for (const stopReason of ["aborted", "stop"] as const) {
    nextResult = async (signal) => await new Promise((resolve) => {
      signal?.addEventListener("abort", () => {
        resolve(providerTextMessage(stopReason, "late answer"));
      }, { once: true });
    });
    assert.deepEqual(await limited.testConnection(draft), {
      status: "failed", failure: "timeout"
    }, "an HTTP 200 stream that exceeds the limit must report timeout, even with late text");
    assert.equal(capturedOptions?.timeoutMs, 5);
  }

  for (const [code, failure] of [
    ["provider_oauth_relogin_required", "auth"],
    ["provider_network_error", "network"],
    ["provider_service_unavailable", "provider"],
    ["provider_protocol_failed", "protocol"],
    ["provider_rate_limited", "rate_limit"]
  ] as const) {
    const requestsBefore = requests;
    const failedAuth = new PiProviderConfigurationService(host, {
      adapters,
      resolveOAuthAccessToken: async () => {
        throw Object.assign(new Error("fixture private detail"), { code });
      }
    });
    const result = await failedAuth.testConnection(draft);
    assert.deepEqual(result, { status: "failed", failure });
    assert.equal(requests, requestsBefore);
    assert.equal(JSON.stringify(result).includes("private detail"), false);
  }
  assert.deepEqual(await new PiProviderConfigurationService(host).testConnection(draft), {
    status: "failed", failure: "auth"
  });
}

function providerTextMessage(
  stopReason: AssistantMessage["stopReason"],
  text: string
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-chat",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason,
    timestamp: Date.now()
  };
}

async function assertResourceScanErrorsClearAcrossTabs(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "resources";
  settings.resourceManagementTab = "skills";
  let scanError = "Vault scan failed";
  const plugin = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    buildRuntimeEchoInkResourceCatalog: async () => {
      settings.resources.lastError = scanError;
      return [];
    }
  };
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutableTab = tab as unknown as {
    resourceLoadErrors: Partial<Record<"plugins" | "mcp" | "skills", string>>;
    loadWorkspaceResources(force: boolean, tab: "plugins" | "mcp" | "skills"): Promise<void>;
  };
  mutableTab.resourceLoadErrors = {
    plugins: "stale plugin scan error",
    mcp: "stale MCP scan error"
  };

  await mutableTab.loadWorkspaceResources(true, "skills");
  assert.equal(mutableTab.resourceLoadErrors.skills, scanError);
  assert.equal(mutableTab.resourceLoadErrors.mcp, "stale MCP scan error");

  scanError = "";
  await mutableTab.loadWorkspaceResources(true, "skills");
  assert.deepEqual(mutableTab.resourceLoadErrors, {});
}

async function assertSkillToggleNotCommittedRestoresAuthoritativeUi(): Promise<void> {
  installProviderModalDomFixture();
  const skill = {
    id: "echoink-local:skill:toggle-rollback",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "toggle-rollback",
    description: "Skill toggle rollback fixture",
    enabled: false,
    bridgeMode: "prompt-only" as const,
    contentPath: ".echoink/skills/toggle-rollback/SKILL.md"
  };
  let persisted = structuredClone(DEFAULT_SETTINGS);
  persisted.settingsTab = "resources";
  persisted.resourceManagementTab = "skills";
  if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "resource-style-candidate") persisted.settingsLanguage = "en";
  persisted.resources.catalog = [skill];
  const plugin: Record<string, any> = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings: structuredClone(persisted),
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    loadData: async () => structuredClone(persisted),
    saveData: async () => {
      throw new Error("fixture-not-committed");
    },
    buildRuntimeEchoInkResourceCatalog: async () =>
      structuredClone(plugin.settings.resources.catalog)
  };
  const store = new EchoInkSettingsStore(plugin as never);
  plugin.setEchoInkSkillResourceEnabled = async (
    resourceId: string,
    enabled: boolean
  ) => await store.withResourceMutation(async () => {
    const previous = structuredClone(plugin.settings.resources);
    const resource = plugin.settings.resources.catalog.find(
      (candidate: typeof skill) => candidate.id === resourceId
    );
    assert.ok(resource);
    resource.enabled = enabled;
    await store.saveResourceMutation(previous);
  });

  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  (tab as unknown as { runtimeEchoInkResources: typeof skill[] })
    .runtimeEchoInkResources = [structuredClone(skill)];
  tab.display();
  const toggle = tab.containerEl.querySelector<ProviderModalTestElement>(
    `[data-echoink-focus-key="resource:${skill.id}:enabled"]`
  );
  assert.ok(toggle);
  const search = tab.containerEl.querySelector<ProviderModalTestElement>(".codex-resource-search-input")!;
  const empty = tab.containerEl.querySelector<ProviderModalTestElement>("[data-resource-search-empty]")!;
  const summary = tab.containerEl.querySelector<ProviderModalTestElement>("[data-resource-summary]")!;
  const enabledColumn = summary.children[1];
  assert.ok(empty);
  assert.equal(empty.hidden, true);
  search.focus(); search.value = "absent-resource"; search.oninput?.();
  const filters = tab as unknown as { applyResourceSearchFilter(tab: string): void; clearResourceSearchDebounceTimer(): void; updateResourceSummaryCounts(): void };
  filters.clearResourceSearchDebounceTimer(); filters.applyResourceSearchFilter("skills");
  assert.equal(empty.hidden, false);
  assert.equal(search.ownerDocument.activeElement, search);
  filters.updateResourceSummaryCounts();
  assert.equal(summary.children[1], enabledColumn);
  writeSettingsStyleFixture(tab.containerEl, "filtered");
  tab.containerEl.querySelector<ProviderModalTestElement>(".codex-resource-search-clear")!.click();
  assert.equal(empty.hidden, true);
  assert.equal(search.value, "");
  assert.equal(search.ownerDocument.activeElement, search);
  assert.equal(summary.children[1], enabledColumn);
  writeSettingsStyleFixture(tab.containerEl, "cleared");
  const row = toggle.closest<ProviderModalTestElement>(".codex-resource-row");
  assert.ok(row);
  assert.equal(toggle.checked, false);
  assert.equal(row.hasClass("is-disabled"), true);

  toggle.checked = true;
  await toggle.onchange?.();
  assert.equal(toggle.checked, false);
  assert.equal(row.hasClass("is-enabled"), false);
  assert.equal(row.hasClass("is-disabled"), true);
  assert.equal(plugin.settings.resources.catalog[0]?.enabled, false);
  assert.equal(persisted.resources.catalog[0]?.enabled, false);
  tab.hide();
}

function writeSettingsStyleFixture(root: HTMLElement, state: string): void {
  if (!["resource-style-candidate", "knowledge-style-candidate", "directory-style-candidate", "spacing-candidate"].includes(process.env.ECHOINK_PROVIDER_SETTINGS_CASE ?? "")) return;
  const escape = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/"/gu, "&quot;");
  const serialize = (element: any): string => {
    const attributes = new Map<string, string>(element.attributeValues);
    if (element.className) attributes.set("class", element.className);
    for (const [name, value] of Object.entries(element.dataset)) attributes.set(`data-${name.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`, String(value));
    if (element.hidden) attributes.set("hidden", "");
    if (element.disabled) attributes.set("disabled", "");
    if (element.checked) attributes.set("checked", "");
    if (element.value) attributes.set("value", element.value);
    return `<${element.localName} ${[...attributes].map(([name, value]) => `${name}="${escape(value)}"`).join(" ")}>${escape(element.ownTextContent)}${element.children.map(serialize).join("")}</${element.localName}>`;
  };
  mkdirSync(process.env.ECHOINK_SETTINGS_TEST_OUTPUT || ".tmp", { recursive: true });
  writeFileSync(path.join(process.env.ECHOINK_SETTINGS_TEST_OUTPUT || ".tmp", `settings-style-${state}.html`), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Resource filter ${state}</title><link rel="stylesheet" href="../styles.css"><style>:root{--font-interface:system-ui;--font-text-size:16px;--text-normal:#303238;--text-muted:#73767e;--background-primary:#fff;--background-secondary:#f7f7f9;--background-modifier-border:#e6e7eb;--interactive-accent:#7860b3}body{margin:0}.setting-item{display:flex}</style>${serialize(root)}`);
}

async function assertBuiltinSkillPresetLabels(): Promise<void> {
  installProviderModalDomFixture();
  const builtinSkills = BUILTIN_SKILL_IDS.map((resourceId) => ({
    id: `echoink-local:skill:${resourceId}`,
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: resourceId,
    description: `${resourceId} fixture`,
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: `.echoink/resources/skills/${resourceId}/SKILL.md`,
    metadata: {
      resourceId,
      ...(resourceId === "daily-journal"
        ? { userModified: true, fileStatus: "ready" }
        : resourceId === "clarify-real-question"
          ? { fileStatus: "missing" }
          : resourceId === "two-layer-explanation"
            ? { fileStatus: "invalid" }
            : { fileStatus: "ready" })
    }
  }));
  const customSkill = {
    id: "echoink-local:skill:user-created",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "user-created",
    description: "User-created Skill fixture",
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: ".echoink/resources/skills/user-created/SKILL.md",
    metadata: { resourceId: "user-created" }
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  settings.settingsTab = "resources";
  settings.resourceManagementTab = "skills";
  settings.resources.catalog = [...builtinSkills, customSkill];
  const plugin = withSettingsTabDefaults({
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    buildRuntimeEchoInkResourceCatalog: async () =>
      structuredClone(settings.resources.catalog)
  });
  const tab = new CodexSettingTab(plugin as never);
  (tab as unknown as { runtimeEchoInkResources: typeof settings.resources.catalog })
    .runtimeEchoInkResources = structuredClone(settings.resources.catalog);

  const assertLanguage = (
    label: string,
    defaultLabel: string,
    customizedLabel: string,
    missingLabel: string,
    invalidLabel: string
  ): void => {
    const badges = tab.containerEl.querySelectorAll<ProviderModalTestElement>(
      ".codex-resource-preset-badge"
    );
    assert.equal(badges.length, BUILTIN_SKILL_IDS.length);
    assert.deepEqual(badges.map((badge) => badge.textContent),
      BUILTIN_SKILL_IDS.map((skillId) =>
        skillId === "daily-journal" ? defaultLabel : label));
    for (const badge of badges) {
      assert.equal(badge.getAttribute("data-resource-preset"), "true");
      const title = badge.parentElement;
      assert.ok(title?.hasClass("codex-resource-row-title"));
      assert.equal(title.children[1], badge, "Preset label must follow the Skill name button");
      assert.equal(title.children[0]?.hasClass("codex-resource-row-name"), true);
    }
    const customRow = tab.containerEl.querySelector<ProviderModalTestElement>(
      `[data-resource-key="${customSkill.id}"]`
    );
    assert.ok(customRow);
    assert.equal(customRow.querySelector(".codex-resource-preset-badge"), null);
    assert.equal(typeof customRow.querySelector(".codex-resource-row-name")?.onclick, "function");
    assert.equal(typeof customRow.querySelector(".codex-resource-toggle")?.onchange, "function");
    const stateBadges = tab.containerEl.querySelectorAll<ProviderModalTestElement>(
      ".codex-resource-state-badge"
    );
    assert.deepEqual(
      stateBadges.map((badge) => badge.textContent),
      [missingLabel, invalidLabel, customizedLabel]
    );
    assert.match(tab.containerEl.textContent, new RegExp(missingLabel, "u"));
    assert.match(tab.containerEl.textContent, new RegExp(invalidLabel, "u"));
  };

  tab.display();
  assertLanguage("预设", "EchoInk 默认", "已自定义", "SKILL.md 缺失", "SKILL.md 损坏");
  settings.settingsLanguage = "en";
  tab.display();
  assertLanguage("Preset", "EchoInk default", "Customized", "SKILL.md missing", "SKILL.md invalid");
  tab.hide();
}

async function assertBuiltinSkillEditorLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const definition = getBuiltinSkillDefinition("daily-journal");
  assert.ok(definition);
  const canonicalContent = renderBuiltinSkill(definition);
  let snapshot: BuiltinSkillRuntimeSnapshot = Object.freeze({
    id: "daily-journal",
    title: definition.title,
    description: definition.description,
    relativePath: ".echoink/resources/skills/daily-journal/SKILL.md",
    fileStatus: "ready",
    lifecycleStatus: "active",
    userModified: false,
    content: canonicalContent
  });
  const resource = {
    id: "echoink-local:skill:daily-journal",
    kind: "skill" as const,
    source: "echoink-local" as const,
    name: "daily-journal",
    description: definition.description,
    enabled: false,
    bridgeMode: "prompt-only" as const,
    contentPath: snapshot.relativePath,
    metadata: {
      resourceId: "daily-journal",
      builtin: true,
      userModified: false,
      fileStatus: "ready",
      lifecycleStatus: "active"
    }
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  settings.settingsTab = "resources";
  settings.resourceManagementTab = "skills";
  settings.resources.catalog = [structuredClone(resource)];
  let savedContent = "";
  let restoreCalls = 0;
  const runtimeResource = () => ({
    ...structuredClone(resource),
    enabled: settings.resources.catalog[0]?.enabled ?? false,
    metadata: {
      ...resource.metadata,
      userModified: snapshot.userModified,
      fileStatus: snapshot.fileStatus,
      lifecycleStatus: snapshot.lifecycleStatus
    }
  });
  const plugin = withSettingsTabDefaults({
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    buildRuntimeEchoInkResourceCatalog: async () => [runtimeResource()],
    readEchoInkBuiltinSkill: async () => snapshot,
    saveEchoInkBuiltinSkill: async (
      skillId: "daily-journal",
      content: string
    ) => {
      assert.equal(skillId, "daily-journal");
      savedContent = content;
      snapshot = Object.freeze({
        ...snapshot,
        fileStatus: "ready",
        userModified: true,
        content
      });
      return snapshot;
    },
    restoreEchoInkBuiltinSkill: async (skillId: "daily-journal") => {
      assert.equal(skillId, "daily-journal");
      restoreCalls += 1;
      snapshot = Object.freeze({
        ...snapshot,
        fileStatus: "ready",
        userModified: false,
        content: canonicalContent
      });
      return snapshot;
    }
  });
  const tab = new CodexSettingTab(plugin as never);
  (tab as unknown as { runtimeEchoInkResources: ReturnType<typeof runtimeResource>[] })
    .runtimeEchoInkResources = [runtimeResource()];
  tab.display();
  const openDetail = tab.containerEl.querySelector<HTMLButtonElement>(
    `[data-echoink-focus-key="resource:${resource.id}:detail"]`
  );
  assert.ok(openDetail);
  openDetail.click();
  await flushProviderModalTasks();
  await flushProviderModalTasks();
  tab.display();

  let textarea = tab.containerEl.querySelector<HTMLTextAreaElement>(
    ".echoink-builtin-skill-textarea"
  );
  let save = tab.containerEl.querySelector<HTMLButtonElement>(
    `[data-echoink-focus-key="resource:${resource.id}:skill-save"]`
  );
  assert.ok(textarea);
  assert.ok(save);
  assert.equal(textarea.value, canonicalContent);
  assert.match(tab.containerEl.textContent, /EchoInk 默认 · 已保存/u);
  assert.equal(save.disabled, true);

  textarea.value = `${canonicalContent}\n## 我的补充\n\n只记录本次对话确认的内容。\n`;
  textarea.oninput?.(new Event("input"));
  assert.equal(save.disabled, false);
  save.click();
  await flushProviderModalTasks();
  await flushProviderModalTasks();
  assert.equal(savedContent, textarea.value);
  assert.equal(snapshot.userModified, true);
  assert.equal(settings.resources.catalog[0]?.enabled, false,
    "saving built-in content does not enable the Skill");

  tab.display();
  assert.match(tab.containerEl.textContent, /已自定义 · 已保存/u);
  const restore = tab.containerEl.querySelector<HTMLButtonElement>(
    `[data-echoink-focus-key="resource:${resource.id}:skill-restore"]`
  );
  assert.ok(restore);
  const modalCountBefore = openTestModals.length;
  restore.click();
  assert.equal(restoreCalls, 0,
    "restoring a built-in Skill waits for explicit confirmation");
  assert.equal(openTestModals.length, modalCountBefore + 1);
  const modal = openTestModals.at(-1);
  assert.ok(modal);
  assert.match(modal.contentEl.textContent, /不会改变 Skill 的启用开关/u);
  const modalButtons = modal.contentEl.querySelectorAll<HTMLButtonElement>("button");
  modalButtons[modalButtons.length - 1]?.click();
  await flushProviderModalTasks();
  await flushProviderModalTasks();
  assert.equal(restoreCalls, 1);
  assert.equal(snapshot.userModified, false);
  assert.equal(snapshot.content, canonicalContent);
  assert.equal(settings.resources.catalog[0]?.enabled, false,
    "restoring built-in content preserves the Skill enable switch");

  tab.display();
  textarea = tab.containerEl.querySelector<HTMLTextAreaElement>(
    ".echoink-builtin-skill-textarea"
  );
  save = tab.containerEl.querySelector<HTMLButtonElement>(
    `[data-echoink-focus-key="resource:${resource.id}:skill-save"]`
  );
  assert.ok(textarea);
  assert.ok(save);
  assert.equal(textarea.value, canonicalContent);
  assert.match(tab.containerEl.textContent, /EchoInk 默认 · 已保存/u);
  tab.hide();
}

async function assertDefaultSkillProductionAvailabilityGate(): Promise<void> {
  const calls: string[] = [];
  let enabled = false;
  const requireAvailable = CodexForObsidianPlugin.prototype
    .requireAvailableEchoInkSkill;
  const host = {
    buildRuntimeEchoInkResourceCatalog: async () => [{
      id: "echoink-local:skill:daily-journal",
      kind: "skill" as const,
      source: "echoink-local" as const,
      name: "daily-journal",
      description: "Daily journal fixture",
      enabled,
      bridgeMode: "prompt-only" as const,
      contentPath: ".echoink/resources/skills/daily-journal/SKILL.md",
      metadata: {
        resourceId: "daily-journal",
        fileStatus: "ready",
        lifecycleStatus: "active"
      }
    }]
  };
  const plugin = {
    requireAvailableEchoInkSkill: async (skillId: string) => {
      calls.push(`availability:${skillId}`);
      return await requireAvailable.call(host as never, skillId);
    }
  };
  const skillRuntime = {
    resolveById: async (skillId: string) => {
      calls.push(`runtime:${skillId}`);
      return {
        id: skillId,
        skillPath: `/fixture/${skillId}/SKILL.md`,
        skillName: skillId,
        revision: "a".repeat(64),
        skills: [],
        applicableSkillIds: [skillId],
        requiresFreshnessVerification: false
      };
    }
  };

  await assert.rejects(
    resolvePiProductionSkillById(plugin, skillRuntime as never, "daily-journal"),
    /Skill daily-journal 已停用/u
  );
  assert.deepEqual(calls, ["availability:daily-journal"],
    "a disabled default Skill must stop before runtime resolution");

  enabled = true;
  await resolvePiProductionSkillById(
    plugin,
    skillRuntime as never,
    "daily-journal"
  );
  assert.deepEqual(calls, [
    "availability:daily-journal",
    "availability:daily-journal",
    "runtime:daily-journal"
  ], "an enabled default Skill is validated before its live file is resolved");
}

async function assertRollbackSafeResourceCatalogKeepsBuiltinFileState(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-resource-rollback-"));
  try {
    const definition = getBuiltinSkillDefinition("daily-journal");
    assert.ok(definition);
    for (const fileStatus of ["missing", "invalid"] as const) {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.resources.catalog = [{
        id: "echoink-local:skill:daily-journal",
        kind: "skill",
        source: "echoink-local",
        name: "daily-journal",
        description: definition.description,
        enabled: true,
        bridgeMode: "prompt-only",
        contentPath: ".echoink/resources/skills/daily-journal/SKILL.md",
        metadata: {
          resourceId: "daily-journal",
          builtin: true,
          userModified: false,
          fileStatus: "ready",
          lifecycleStatus: "active"
        }
      }];
      const snapshot: BuiltinSkillRuntimeSnapshot = Object.freeze({
        id: "daily-journal",
        title: definition.title,
        description: definition.description,
        relativePath: ".echoink/resources/skills/daily-journal/SKILL.md",
        fileStatus,
        lifecycleStatus: "active",
        userModified: false,
        content: "",
        error: `fixture-${fileStatus}`
      });
      const service = new EchoInkResourceCatalogService({
        settings,
        getVaultPath: () => vaultPath,
        getSkillRuntimeCoordinator: () => ({
          inspectBuiltinSkills: async () => [snapshot]
        }) as never,
        withEchoInkResourceMutation: async <R>(action: () => Promise<R>) =>
          await action(),
        saveEchoInkResourceMutation: async (previousResources) => {
          settings.resources = structuredClone(previousResources);
          throw new ResourceMutationError(
            "fixture resource save rolled back",
            true,
            false,
            true
          );
        }
      });

      const catalog = await service.buildRuntimeCatalog();
      assert.equal(
        settings.resources.catalog[0]?.metadata?.fileStatus,
        "ready",
        "safe rollback restores the authoritative persisted catalog"
      );
      assert.equal(
        catalog.find((resource) => resource.metadata?.resourceId === "daily-journal")
          ?.metadata?.fileStatus,
        fileStatus,
        "the runtime catalog must retain the latest built-in file probe after safe rollback"
      );
    }
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertProviderApiKeyEditLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const existing = createApiProviderConfig("custom", "custom-api-key-edit");
  existing.baseUrl = "https://custom.example/v1";
  replaceProviderModels(existing, "custom-model");
  existing.apiKey = "saved-api-key";

  let blankDraft: typeof existing | null = null;
  let blankInput = "not-called";
  const blankModal = new ProviderModelModal({
    app: new App(),
    draft: existing,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => ({ status: "unsupported" }),
      testConnection: async () => ({ status: "available" })
    },
    save: async (draft, apiKey) => {
      blankDraft = structuredClone(draft);
      blankInput = apiKey;
      return { saved: true };
    }
  });
  blankModal.open();
  const blankKey = providerModalElementByFocusKey(blankModal, "apiKey");
  assert.ok(blankKey);
  assert.match(blankKey.getAttribute("placeholder") ?? "", /saved/u);
  assert.equal(blankKey.value, "");
  providerModalElementByFocusKey(blankModal, "save")?.click();
  await flushProviderModalTasks();
  assert.equal(blankDraft?.apiKey, "saved-api-key");
  assert.equal(blankInput, "");

  let replacementDraft: typeof existing | null = null;
  let replacementInput = "";
  const replacementModal = new ProviderModelModal({
    app: new App(),
    draft: existing,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => ({ status: "unsupported" }),
      testConnection: async () => ({ status: "available" })
    },
    save: async (draft, apiKey) => {
      replacementDraft = structuredClone(draft);
      replacementInput = apiKey;
      return { saved: true };
    }
  });
  replacementModal.open();
  const replacementKey = providerModalElementByFocusKey(
    replacementModal,
    "apiKey"
  );
  assert.ok(replacementKey);
  replacementKey.value = "replacement-api-key";
  replacementKey.oninput?.();
  providerModalElementByFocusKey(replacementModal, "save")?.click();
  await flushProviderModalTasks();
  assert.equal(replacementDraft?.apiKey, "saved-api-key");
  assert.equal(replacementInput, "replacement-api-key");
  assert.doesNotMatch(
    replacementModal.contentEl.textContent,
    /Credential|凭据|轮换|撤销/u
  );
}

async function assertPersistedProviderRollbackPreservesQueuedSettingsSave(): Promise<void> {
  const old = createApiProviderConfig("deepseek", "persisted-old");
  old.apiKey = "persisted-old-api-key";
  let persisted = structuredClone(DEFAULT_SETTINGS);
  persisted.apiProviders = [old];
  activateApiProvider(persisted, old);
  const plugin = {
    settings: structuredClone(persisted),
    loadData: async () => structuredClone(persisted),
    saveData: async (value: unknown) => {
      persisted = structuredClone(value) as typeof persisted;
    }
  };
  const store = new EchoInkSettingsStore(plugin as never);
  const providerSnapshot = await store.readPersistedApiProviderSettingsSnapshot();
  const candidate = createApiProviderConfig("deepseek", "persisted-candidate");
  candidate.apiKey = "persisted-candidate-api-key";
  persisted.apiProviders = [candidate];
  activateApiProvider(persisted, candidate);
  const concurrentSave = store.withSettingsPersistenceAuthorityGate(async () => {
    persisted.settingsLanguage = "en";
    persisted.customWelcomeEnabled = true;
    persisted.customWelcomeTitle = "Concurrent title";
  });
  const rollback = store.restorePersistedApiProviderSettingsSnapshot(
    providerSnapshot
  );
  await Promise.all([concurrentSave, rollback]);
  assert.equal(persisted.activeApiProviderId, old.id);
  assert.equal(persisted.settingsLanguage, "en");
  assert.equal(persisted.customWelcomeEnabled, true);
  assert.equal(persisted.customWelcomeTitle, "Concurrent title");
}

function assertConversationSettingsDiscardMessageBodies(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sessions = [{
    id: "conversation-persistence-shell",
    title: "Persistence shell",
    piSessionId: "pi-conversation-persistence-shell",
    bodyAuthority: "pi_session_only",
    cwd: "/disposable-vault",
    messages: [{
      id: "durable-message-body",
      role: "assistant",
      text: "This message must remain in the Pi Session, not settings.",
      createdAt: 1
    }],
    piImageAttachments: {
      "entry-image-metadata": [{
        name: "first.png",
        path: "/disposable-vault/first.png",
        mimeType: "image/png",
        availability: "available",
        data: "SETTINGS_BASE64_CANARY"
      }, {
        name: "second.jpg",
        path: "/disposable-vault/second.jpg",
        mimeType: "image/jpeg",
        availability: "unavailable",
        base64: "SETTINGS_SECOND_BASE64_CANARY"
      }]
    } as never,
    createdAt: 1,
    updatedAt: 2
  }];
  settings.activeSessionId = "conversation-persistence-shell";

  const persisted = settingsForDataSave(settings);
  assert.equal(persisted.activeSessionId, settings.activeSessionId);
  assert.deepEqual(persisted.sessions[0]?.messages, []);
  assert.deepEqual(persisted.sessions[0]?.piImageAttachments, {
    "entry-image-metadata": [{
      name: "first.png",
      path: "/disposable-vault/first.png",
      mimeType: "image/png",
      availability: "available"
    }, {
      name: "second.jpg",
      path: "/disposable-vault/second.jpg",
      mimeType: "image/jpeg",
      availability: "unavailable"
    }]
  });
  assert.deepEqual(
    normalizeSettingsData(persisted).settings.sessions[0]?.piImageAttachments,
    persisted.sessions[0]?.piImageAttachments
  );
  assert.equal(
    settings.sessions[0]?.messages[0]?.id,
    "durable-message-body",
    "persisting the settings shell must not mutate the live active body"
  );
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /This message must remain in the Pi Session|SETTINGS_(?:SECOND_)?BASE64_CANARY/u
  );
  assert.match(
    JSON.stringify(settings),
    /SETTINGS_BASE64_CANARY/u,
    "settings projection must not mutate live local metadata while sanitizing"
  );
}

async function assertProviderApiKeyPersistenceLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const provider = createApiProviderConfig("deepseek", "direct-api-key");
  provider.apiKey = "direct-provider-api-key";
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.apiProviders = [provider];
  activateApiProvider(settings, provider);
  let persisted: unknown = null;
  const plugin = {
    settings,
    loadData: async () => structuredClone(persisted),
    saveData: async (value: unknown) => {
      persisted = structuredClone(value);
    }
  };
  const store = new EchoInkSettingsStore(plugin as never);
  await store.saveSettings(true, {
    flushConversationStore: false,
    flushRawWrites: false
  });
  const persistedProvider = (
    persisted as typeof settings
  ).apiProviders[0];
  assert.equal(persistedProvider?.apiKey, "direct-provider-api-key");
  assert.equal(Object.hasOwn(persistedProvider ?? {}, "providerRef"), false);
  assert.equal(Object.hasOwn(persistedProvider ?? {}, "credentialRef"), false);

  const reloadedPlugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    getVaultPath: () => path.join(tmpdir(), "echoink-provider-key-persistence-fixture"),
    getPluginDataDirName: () => ".obsidian/plugins/echoink",
    loadData: async () => structuredClone(persisted),
    saveData: async (value: unknown) => {
      persisted = structuredClone(value);
    }
  };
  await new EchoInkSettingsStore(reloadedPlugin as never).loadSettings();
  assert.equal(
    reloadedPlugin.settings.apiProviders[0]?.apiKey,
    "direct-provider-api-key"
  );

  const editingSettings = structuredClone(reloadedPlugin.settings);
  const editingProvider = editingSettings.apiProviders[0]!;
  const tabPlugin = {
    app: new App(),
    settings: editingSettings,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    activateApiProviderSettings: async (
      apply: (candidate: typeof editingSettings) => void
    ) => apply(editingSettings)
  };
  const tab = new CodexSettingTab(withSettingsTabDefaults(tabPlugin) as never) as unknown as {
    saveAndActivateProviderModel(
      draft: typeof editingProvider,
      apiKey: string,
      connectionVerified?: boolean,
      replacedProvider?: typeof editingProvider | null
    ): Promise<Readonly<{ saved: boolean; message?: string }>>;
  };
  assert.equal((await tab.saveAndActivateProviderModel(
    structuredClone(editingProvider),
    "",
    false,
    editingProvider
  )).saved, true);
  assert.equal(editingSettings.apiProviders[0]?.apiKey, "direct-provider-api-key");
  const providerAfterFirstEdit = editingSettings.apiProviders[0]!;
  assert.equal((await tab.saveAndActivateProviderModel(
    structuredClone(providerAfterFirstEdit),
    "replacement-provider-api-key",
    false,
    providerAfterFirstEdit
  )).saved, true);
  assert.equal(
    editingSettings.apiProviders[0]?.apiKey,
    "replacement-provider-api-key"
  );

  const collidingAddition = structuredClone(editingSettings.apiProviders[0]!);
  collidingAddition.name = "Backup account";
  assert.equal((await tab.saveAndActivateProviderModel(
    collidingAddition,
    "second-provider-api-key",
    false,
    null
  )).saved, true);
  assert.equal(editingSettings.apiProviders.length, 2);
  assert.equal(new Set(editingSettings.apiProviders.map(({ id }) => id)).size, 2);
  assert.equal(
    editingSettings.apiProviders[0]?.apiKey,
    "replacement-provider-api-key",
    "adding a same-preset Provider must not replace the existing API key"
  );
  assert.equal(editingSettings.apiProviders[1]?.apiKey, "second-provider-api-key");
  assert.equal(editingSettings.apiProviders[1]?.name, "Backup account");

  const addedProvider = editingSettings.apiProviders[1]!;
  assert.equal((await tab.saveAndActivateProviderModel(
    structuredClone(addedProvider),
    "updated-second-provider-api-key",
    false,
    addedProvider
  )).saved, true);
  assert.equal(editingSettings.apiProviders.length, 2);
  assert.equal(
    editingSettings.apiProviders[0]?.apiKey,
    "replacement-provider-api-key",
    "editing the second same-preset Provider must not change the first"
  );
  assert.equal(
    editingSettings.apiProviders[1]?.apiKey,
    "updated-second-provider-api-key"
  );
}

async function assertOpenAICodexCredentialStoreContract(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const persistedStates: Array<string | null> = [];
  const host = {
    settings,
    saveSettings: async () => {
      persistedStates.push(
        settings.openAICodexCredential?.access ?? null
      );
    }
  };
  const store = new OpenAICodexSettingsCredentialStore(host);
  const firstGate = deferred<void>();
  const first = store.modify("openai-codex", async (current) => {
    assert.equal(current, undefined);
    await firstGate.promise;
    return codexCredentialFixture("first");
  });
  let secondStarted = false;
  const second = store.modify("openai-codex", async (current) => {
    secondStarted = true;
    assert.equal(current?.type, "oauth");
    assert.equal(current?.access, "fixture-access-first");
    return codexCredentialFixture("rotated");
  });
  await flushProviderModalTasks();
  assert.equal(secondStarted, false);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(persistedStates, [
    "fixture-access-first",
    "fixture-access-rotated"
  ]);
  assert.equal(
    settings.openAICodexCredential?.refresh,
    "fixture-refresh-rotated"
  );
  assert.deepEqual(await store.list(), [{
    providerId: "openai-codex",
    type: "oauth"
  }]);

  const oauth = new OpenAICodexOAuthService(host);
  assert.equal((await oauth.status()).state, "connected");
  assert.equal(
    await oauth.resolveAccessToken(),
    "fixture-access-rotated"
  );
  await oauth.logout();
  assert.equal(settings.openAICodexCredential, null);
  assert.equal((await oauth.status()).state, "disconnected");
  await assert.rejects(
    oauth.resolveAccessToken(),
    /OpenAI Codex 授权已失效，请在设置中重新登录/u
  );

  settings.openAICodexCredential = {
    ...codexCredentialFixture("expired"),
    expires: 1
  };
  assert.equal(
    (await new OpenAICodexOAuthService(host).status()).state,
    "expired"
  );

  const beforeFailure = structuredClone(settings.openAICodexCredential);
  const failingStore = new OpenAICodexSettingsCredentialStore({
    settings,
    saveSettings: async () => {
      throw new Error("fixture-persist-failed");
    }
  });
  await assert.rejects(
    failingStore.modify("openai-codex", async () =>
      codexCredentialFixture("not-persisted")
    ),
    /codex_oauth_credential_persist_failed/u
  );
  assert.deepEqual(settings.openAICodexCredential, beforeFailure);
}

function codexCredentialFixture(suffix: string) {
  return {
    type: "oauth" as const,
    access: `fixture-access-${suffix}`,
    refresh: `fixture-refresh-${suffix}`,
    expires: Date.now() + 60_000,
    accountId: `fixture-account-${suffix}`
  };
}

async function assertOpenAICodexLogoutSuspendsRuntime(): Promise<void> {
  const order: string[] = [];
  await logoutOpenAICodexAfterRuntimeSuspension({
    active: true,
    suspendRuntime: async () => {
      order.push("runtime-suspended");
    },
    logout: async () => {
      order.push("credential-deleted");
    }
  });
  assert.deepEqual(order, [
    "runtime-suspended",
    "credential-deleted"
  ]);

  let logoutCalled = false;
  await assert.rejects(
    logoutOpenAICodexAfterRuntimeSuspension({
      active: true,
      suspendRuntime: async () => {
        throw new Error("fixture-runtime-shutdown-failed");
      },
      logout: async () => {
        logoutCalled = true;
      }
    }),
    /fixture-runtime-shutdown-failed/u
  );
  assert.equal(logoutCalled, false);
}

async function assertSettingsPersistenceReadbackOutcomes(): Promise<void> {
  {
    let persisted = structuredClone(DEFAULT_SETTINGS);
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      loadData: async () => structuredClone(persisted),
      saveData: async (value: unknown) => {
        persisted = structuredClone(value) as typeof persisted;
        throw new Error("committed-before-throw");
      }
    };
    plugin.settings.autoOpen = !plugin.settings.autoOpen;
    const store = new EchoInkSettingsStore(plugin as never);
    await store.saveSettings(true, {
      flushConversationStore: false,
      flushRawWrites: false
    });
    assert.equal(persisted.autoOpen, plugin.settings.autoOpen);
  }

  {
    let persisted = structuredClone(DEFAULT_SETTINGS);
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      loadData: async () => structuredClone(persisted),
      saveData: async (value: unknown) => {
        const target = structuredClone(value) as typeof persisted;
        persisted = {
          ...target,
          autoOpen: !target.autoOpen,
          resources: {
            ...target.resources,
            catalog: target.resources.catalog.filter((resource) =>
              resource.source !== "echoink-local")
          }
        };
        throw new Error("unknown-readback");
      }
    };
    plugin.settings.autoOpenHome = !plugin.settings.autoOpenHome;
    const store = new EchoInkSettingsStore(plugin as never);
    await assert.rejects(store.saveSettings(true, {
      flushConversationStore: false,
      flushRawWrites: false
    }), (error: unknown) => {
      assert.ok(error instanceof SettingsPersistenceError);
      assert.equal(error.persistenceStatus, "unknown");
      assert.deepEqual(error.persistedSettings, normalizeSettingsData(persisted).settings);
      return true;
    });
  }

  {
    const skill = {
      id: "echoink-local:skill:authoritative-readback",
      kind: "skill" as const,
      source: "echoink-local" as const,
      name: "authoritative-readback",
      description: "Resource persistence fixture",
      enabled: false,
      bridgeMode: "prompt-only" as const,
      contentPath: ".echoink/skills/authoritative-readback/SKILL.md"
    };
    let persisted = structuredClone(DEFAULT_SETTINGS);
    persisted.resources.catalog = [skill];
    const plugin = {
      settings: structuredClone(persisted),
      loadData: async () => structuredClone(persisted),
      saveData: async (value: unknown) => {
        const target = structuredClone(value) as typeof persisted;
        persisted = {
          ...target,
          resources: {
            ...target.resources,
            catalog: target.resources.catalog.map((resource) => ({
              ...resource,
              enabled: false
            })),
            lastError: "authoritative-resource-readback"
          }
        };
        throw new Error("resource-commit-unknown");
      }
    };
    const store = new EchoInkSettingsStore(plugin as never);
    let firstError: ResourceMutationError | null = null;
    await assert.rejects(store.withResourceMutation(async () => {
      const previous = structuredClone(plugin.settings.resources);
      plugin.settings.resources.catalog[0]!.enabled = true;
      await store.saveResourceMutation(previous);
    }), (error: unknown) => {
      assert.ok(error instanceof ResourceMutationError);
      firstError = error;
      assert.equal(error.rollbackSafe, false);
      assert.equal(error.candidateMayBePersisted, true);
      assert.equal(error.authorityKnown, true);
      return true;
    });
    assert.deepEqual(plugin.settings.resources, persisted.resources);
    assert.equal(plugin.settings.resources.catalog[0]?.enabled, false);
    await assert.rejects(
      store.withResourceMutation(async () => undefined),
      (error: unknown) => {
        assert.ok(firstError);
        assert.equal(error, firstError, "the separate unsafe resource-mutation guard remains in force");
        return true;
      }
    );
  }
}

function assertProviderBadgeReflowCssContract(): void {
  const css = readFileSync(path.resolve("styles.css"), "utf8");
  const settingsTab = readFileSync(
    path.resolve("src/settings/settings-tab.ts"),
    "utf8"
  );
  assert.match(css, /\.codex-provider-credential-badge,[\s\S]*\.codex-provider-connection-badge\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u);
  const activeBadgeRule = css.match(
    /\.codex-provider-active-badge\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  assert.match(activeBadgeRule, /color:\s*var\(--text-normal\)/u);
  assert.match(activeBadgeRule, /background:\s*color-mix\(in srgb,\s*var\(--interactive-accent\) 8%,\s*var\(--background-primary\)\)/u);
  assert.doesNotMatch(activeBadgeRule, /color:\s*var\(--text-accent\)/u);
  const successBadgeRule = css.match(
    /\.codex-provider-credential-badge\.is-ready,\s*\.codex-provider-connection-badge\.is-connected\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  assert.match(successBadgeRule, /color:\s*var\(--text-normal\)/u);
  assert.match(successBadgeRule, /background:\s*color-mix\([\s\S]*var\(--text-success,[\s\S]*12%[\s\S]*var\(--background-primary\)/u);
  assert.doesNotMatch(successBadgeRule, /background-modifier-success/u);
  assert.match(settingsTab, /label\("API Key 已填写", "API key configured"\)/u);
  assert.match(settingsTab, /label\("连接正常", "Connection verified"\)/u);
  assert.match(settingsTab, /label\("无需 API Key", "No API key required"\)/u);
  assertProviderBadgeDefaultThemeContrast();
  assert.match(css, /\.codex-provider-saved-provider\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/u);
  const narrowProviderRule = css.match(
    /@container \(max-width:\s*520px\)\s*\{([\s\S]*?)\n\}/u
  )?.[1] ?? "";
  assert.match(narrowProviderRule, /\.codex-provider-saved-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(narrowProviderRule, /\.codex-provider-saved-provider\s*\{[^}]*width:\s*100%;/u);
  assert.doesNotMatch(css, /\.codex-provider-url-tooltip/u, "provider URLs use the host tooltip rather than a second custom panel");
  const narrowSettingsRule = css.match(
    /@container \(max-width:\s*560px\)\s*\{\s*\.echoink-settings-page\s*\{[\s\S]*?\n\}/u
  )?.[0] ?? "";
  assert.match(narrowSettingsRule, /\.echoink-settings-row \.setting-item-control\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/u);
  assert.match(narrowSettingsRule, /\.echoink-settings-row \.setting-item-control > select\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/u);
  assert.match(narrowSettingsRule, /\.echoink-settings-row \.setting-item-control > button:not\(:where\(\[data-slot=switch\],\[data-slot=checkbox\],\[data-slot=radio-group-item\],\[data-slot=select-trigger\]\)\)\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u);
  assert.match(narrowSettingsRule, /\.echoink-settings-navigation-value\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u);
}

function assertProviderAdvancedSettingsCssContract(): void {
  const css = readFileSync(path.resolve("styles.css"), "utf8");
  assert.match(
    css,
    /\.codex-provider-model-advanced\s*\{[^}]*container-type:\s*inline-size;/su
  );
  assert.match(
    css,
    /\.codex-provider-model-choice-enabled > span\s*\{[^}]*overflow-wrap:\s*anywhere;/su
  );
  assert.match(
    css,
    /\.codex-provider-model-advanced-description\s*\{[^}]*line-height:\s*1\.5;[^}]*overflow-wrap:\s*break-word;/su
  );
  const unknownRule = css.match(
    /\.codex-provider-model-capabilities\.is-unknown\s*\{([^}]*)\}/u
  )?.[1] ?? "";
  assert.match(unknownRule, /color:\s*var\(--text-muted\)/u);
  assert.doesNotMatch(unknownRule, /text-warning/u);
}

function assertProviderBadgeDefaultThemeContrast(): void {
  const renderedThemeColors = {
    light: {
      textNormal: [34, 34, 34],
      activeBackground: [0.967809, 0.956104, 0.997416].map(srgbUnitToByte),
      successBackground: [225, 247, 234]
    },
    dark: {
      textNormal: [218, 218, 218],
      activeBackground: [0.144245, 0.129884, 0.177756].map(srgbUnitToByte),
      successBackground: [33, 49, 38]
    }
  } as const;
  for (const [theme, colors] of Object.entries(renderedThemeColors)) {
    assert.ok(
      contrastRatio(colors.textNormal, colors.activeBackground) >= 4.5,
      `${theme} active Provider badge must meet 4.5:1 contrast`
    );
    assert.ok(
      contrastRatio(colors.textNormal, colors.successBackground) >= 4.5,
      `${theme} successful Provider badge must retain 4.5:1 contrast`
    );
  }
}

function srgbUnitToByte(value: number): number {
  return value * 255;
}

function contrastRatio(
  foreground: readonly number[],
  background: readonly number[]
): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: readonly number[]): number {
  const [red = 0, green = 0, blue = 0] = color.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045
      ? srgb / 12.92
      : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}


/** Minimal CognitiveSystem stub for settings-tab tests (no Provider, no files). */


function createCognitiveSystemStub(): Record<string, any> {
  return {
    listSecondaryForParent: async () => [], listAllSecondary: async () => [],
    updateSecondaryFact: async () => { throw new Error("cognitive stub"); },
    deleteSecondaryFact: async () => { throw new Error("cognitive stub"); }
  };
}

async function assertSettingsAccessibleNamesAndOverflow(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const provider = createApiProviderConfig("deepseek", "ui-contract");
  provider.apiKey = "ui-contract-api-key";
  const missingCredential = createApiProviderConfig(
    "deepseek",
    "ui-contract-missing"
  );
  missingCredential.name = "备用 DeepSeek";
  const credentialFree = createApiProviderConfig(
    "ollama",
    "ui-contract-no-key"
  );
  const customProvider = createApiProviderConfig(
    "custom",
    "ui-contract-custom"
  );
  customProvider.name = "A/B Private Gateway";
  customProvider.apiKey = "fixture-custom-key";
  customProvider.models = [createApiProviderModelConfig(
    "custom",
    "manual-model",
    customProvider.runtimeProviderId
  )];
  customProvider.defaultModelId = customProvider.models[0].id;
  settings.apiProviders = [
    provider,
    missingCredential,
    credentialFree,
    customProvider
  ];
  activateApiProvider(settings, provider);
  settings.settingsTab = "providers";
  settings.settingsLanguage = "zh-CN";
  const maintenanceReportPath = "outputs/maintenance-2026-08-25.md";
  settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  for (const role of ["raw", "wiki"] as const) Object.assign(settings.knowledgeBase.folderBindings.roles[role], { enabled: true, readPaths: [role], writePath: role });
  const boundFolders = new Map(["raw", "wiki"].map(relative => [relative, Object.assign(new TFolder(), { path: relative })]));
  const previousMaintenanceReportPath = "outputs/maintenance-2026-08-24.md";
  const maintenanceAt = Date.UTC(2026, 7, 25, 6, 30);
  const previousMaintenanceAt = Date.UTC(2026, 7, 24, 6, 30);
  settings.knowledgeBase.maintenanceHistory = [
    {
      date: "2026-08-25",
      status: "success",
      at: maintenanceAt,
      runId: "run-settings-dashboard",
      mode: "maintain",
      reportPath: maintenanceReportPath,
      completion: "partial",
      pendingSources: ["raw/pending.md"]
    },
    {
      date: "2026-08-24",
      status: "success",
      at: previousMaintenanceAt,
      runId: "run-settings-dashboard-previous",
      mode: "lint",
      reportPath: previousMaintenanceReportPath,
      completion: "noop"
    }
  ];
  const openedReports: string[] = [];
  const reportFiles = new Map<string, TFile>([
    [maintenanceReportPath, Object.assign(Object.create(TFile.prototype) as TFile, {
      path: maintenanceReportPath
    })],
    [previousMaintenanceReportPath, Object.assign(Object.create(TFile.prototype) as TFile, {
      path: previousMaintenanceReportPath
    })]
  ]);
  const app = Object.assign(new App(), {
    vault: {
      getAbstractFileByPath: (value: string) => reportFiles.get(value) ?? boundFolders.get(value) ?? null
    },
    workspace: {
      getLeaf: () => ({
        openFile: async (file: TFile) => {
          openedReports.push(file.path);
        }
      })
    }
  });
  const identityState = Object.freeze({
    user: "# User",
    memory: "# Memory",
    revision: 1,
    records: Object.freeze([Object.freeze({
      schema: "echoink.memory.v1",
      id: "mem_ui_private_id",
      kind: "fact",
      status: "current",
      date: "2026-08-15",
      source: "ui://private-source",
      basis: "explicit",
      contentOrigin: "user_statement",
      title: "当前事实",
      recallWhen: "需要核对事实时",
      content: "用户可见的事实正文",
      revision: 1,
      file: "records/facts/private.md"
    })]),
    forgottenIds: Object.freeze([])
  });
  const forgetCalls: Array<readonly [string, string, number]> = [];
  const plugin = {
    app,
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getEchoInkPersonalMemoryState: async () => identityState,
    getEchoInkKnowledgeMaintenancePreferenceState: async () => ({
      profileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
      state: "default" as const,
      revision: `sha256:${"b".repeat(64)}`,
      content: ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
    }),
    forgetEchoInkPersonalMemory: async (id: string, reason: string, revision: number) => {
      forgetCalls.push([id, reason, revision]);
    },
    getKnowledgeSurfaceService: () => ({
      getMaintenanceRecords: async () => [],
      folderOperationBusy: false,
      directoryWritable: true,
      folderOperationMessage: "",
      folderNameScopes: () => [],
      getOriginalDirectoryStatus: async () => null,
      maintenanceRecoveryStatus: { state: "ready" as const, message: "" }
    }),
    getEchoInkKnowledgeBaseStructure: async () =>
      makeKnowledgeBaseStructureFixture("ready"),
    listPiConversations: async () => [],
    setPiConversationStatus: async () => undefined,
    getCodexView: () => null
  };
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  tab.display();
  const tabs = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".codex-settings-tabs"
  );
  assert.ok(tabs);
  tabs.clientWidth = 200;
  tabs.scrollWidth = 500;
  providerModalResizeObservers.at(-1)?.notify();
  assert.equal(tabs.parentElement?.hasClass("can-scroll-right"), true);
  const activeTabButton = tabs.querySelector<ProviderModalTestElement>('[aria-selected="true"]')!;
  const originalTabsRect = tabs.getBoundingClientRect;
  const originalActiveRect = activeTabButton.getBoundingClientRect;
  tabs.getBoundingClientRect = () => ({ left: 0, right: 200 } as DOMRect);
  activeTabButton.getBoundingClientRect = () => ({ left: 215, right: 290 } as DOMRect);
  tab.containerEl.scrollTop = 180;
  const focusBeforeResize = providerModalTestDocument.activeElement;
  providerModalResizeObservers.at(-1)?.notify();
  assert.equal(tabs.scrollLeft, 90, "shrinking reveals the active tab within the horizontal strip");
  assert.equal(tab.containerEl.scrollTop, 180, "tab resize must not move page content");
  assert.equal(providerModalTestDocument.activeElement, focusBeforeResize);
  tabs.getBoundingClientRect = originalTabsRect;
  activeTabButton.getBoundingClientRect = originalActiveRect;

  const identity = tab.containerEl.querySelector(
    ".codex-provider-saved-identity"
  );
  assert.match(identity?.getAttribute("aria-label") ?? "", /深度求索/u);
  const savedProviderName = (providerId: string) => tab.containerEl
    .querySelector<ProviderModalTestElement>(
      `[data-echoink-focus-key="provider:${providerId}:edit"]`
    )
    ?.closest(".codex-provider-saved-row")
    ?.querySelector<ProviderModalTestElement>(".codex-provider-saved-provider")
    ?.textContentAssignments.at(-1);
  assert.equal(savedProviderName(provider.id), "深度求索");
  assert.equal(savedProviderName(missingCredential.id), "备用 DeepSeek");
  assert.equal(savedProviderName(customProvider.id), customProvider.name);
  assert.equal(
    apiProviderConfiguredDisplayName(
      "deepseek",
      "旧名称 / Legacy name",
      "zh-CN"
    ),
    "旧名称 / Legacy name"
  );
  assert.equal(
    apiProviderConfiguredDisplayName(
      "deepseek",
      "旧名称 / Legacy name",
      "en"
    ),
    "旧名称 / Legacy name"
  );
  assert.equal(
    apiProviderConfiguredDisplayName(
      "custom",
      getApiProviderPreset("custom").name,
      "zh-CN"
    ),
    "自定义"
  );
  assert.equal(
    apiProviderConfiguredDisplayName(
      "custom",
      getApiProviderPreset("custom").name,
      "en"
    ),
    "Custom"
  );
  for (const language of ["zh-CN", "en"] as const) {
    assert.equal(apiProviderConfiguredDisplayName("anthropic", "Anthropic / Anthropic", language), "Claude Code");
    assert.equal(apiProviderConfiguredDisplayName("anthropic", "Anthropic", language), "Claude Code");
    assert.equal(apiProviderConfiguredDisplayName("anthropic", "My private Claude", language), "My private Claude");
  }
  settings.settingsLanguage = "en";
  tab.display();
  assert.equal(savedProviderName(provider.id), "DeepSeek");
  assert.equal(savedProviderName(missingCredential.id), "备用 DeepSeek");
  assert.equal(savedProviderName(customProvider.id), customProvider.name);
  settings.settingsLanguage = "zh-CN";
  tab.display();
  for (const action of ["edit", "delete"]) {
    const button = tab.containerEl.querySelector(
      `[data-echoink-focus-key="provider:${provider.id}:${action}"]`
    );
    assert.match(button?.getAttribute("aria-label") ?? "", /深度求索/u);
  }
  const providerRows = new Map([
    [provider.id, ["API Key 已填写", "is-ready"]],
    [missingCredential.id, ["未配置 API Key", "is-missing"]],
    [credentialFree.id, ["无需 API Key", "is-not-required"]]
  ] as const);
  for (const [providerId, [expectedText, expectedClass]] of providerRows) {
    const row = tab.containerEl.querySelector(
      `[data-echoink-focus-key="provider:${providerId}:edit"]`
    )?.closest(".codex-provider-saved-row");
    assert.ok(row);
    const badges = row.querySelectorAll(".codex-provider-credential-badge");
    assert.equal(badges.length, 1);
    assert.equal(badges[0]?.textContent, expectedText);
    assert.equal(badges[0]?.hasClass(expectedClass), true);
  }
  const credentialFreeRow = tab.containerEl.querySelector(
    `[data-echoink-focus-key="provider:${credentialFree.id}:edit"]`
  )?.closest(".codex-provider-saved-row");
  assert.equal(
    credentialFreeRow?.querySelector(".codex-provider-connection-badge"),
    null
  );

  settings.settingsTab = "review";
  tab.display();
  for (const label of ["生成 Agent 周报", "生成知识库周报"]) {
    const button = Array.from(tab.containerEl.querySelectorAll("button"))
      .find((candidate) => candidate.getAttribute("aria-label") === label);
    assert.ok(button?.querySelector("strong")?.textContent === label);
  }
  assertSettingControlAccessibleName(tab.containerEl, "输出目录", "input");
  assertSettingControlAccessibleName(tab.containerEl, "统计周期", "select");
  assertSettingsToggleAccessibleName(tab.containerEl, "生成后打开 HTML");
  assert.ok(Array.from(tab.containerEl.querySelectorAll("button"))
    .some((candidate) => candidate.textContent === "选择"));
  const autoArchive = tab.containerEl.querySelector<HTMLSelectElement>('[aria-label="自动归档"]');
  assert.ok(autoArchive, "automatic archive belongs to Review settings");
  assert.deepEqual(Array.from(autoArchive.querySelectorAll("option")).map(option => option.value), ["0", "7", "14", "30", "90"]);
  assert.equal(autoArchive.value, "0");
  assert.ok(tab.containerEl.textContent.indexOf("自动归档") < tab.containerEl.textContent.indexOf("已归档会话"), "automatic archive precedes archived conversations");
  assert.match(tab.containerEl.textContent, /已归档会话/u);
  assert.match(tab.containerEl.textContent, /记忆修正/u);
  assert.doesNotMatch(tab.containerEl.textContent, /最近报告|打开最近 HTML/u);

  assert.doesNotMatch(
    readFileSync("src/ui/codex-view/header.ts", "utf8"),
    /codex-provider-shortcut|codex-header-status/u
  );
  assert.doesNotMatch(
    readFileSync("src/ui/codex-view/view-shell.ts", "utf8"),
    /codex-kb-dashboard/u
  );

  const archivedEntry = Object.freeze({
    conversationId: "conversation-archived",
    piSessionId: "pi-archived",
    vaultId: "vault-disposable",
    title: "归档会话样例",
    status: "archived" as const,
    defaultMemoryMode: "normal" as const,
    createdAt: 1,
    updatedAt: 2,
    sessionFile: "/private/pi-session.jsonl"
  });
  const mutable = tab as unknown as {
    personalMemoryState: typeof identityState;
    archivedConversations: readonly typeof archivedEntry[];
    settingsDetail:
      | "review-archives"
      | "review-memory"
      | { kind: "review-memory-category"; category: "facts" }
      | null;
  };
  mutable.archivedConversations = Object.freeze([archivedEntry]);
  mutable.settingsDetail = "review-archives";
  tab.display();
  assert.match(tab.containerEl.textContent, /归档会话样例/u);
  assert.match(tab.containerEl.textContent, /归档时间/u);
  assert.match(tab.containerEl.textContent, /你可以搜索、恢复或删除会话；删除后无法在设置中恢复。/u);
  assert.ok(tab.containerEl.querySelector('input[aria-label="搜索已归档会话"]'));
  for (const label of ["恢复 归档会话样例", "删除 归档会话样例"]) {
    assert.ok(tab.containerEl.querySelector(`button[aria-label="${label}"]`));
  }
  assert.doesNotMatch(tab.containerEl.textContent, /pi-session\.jsonl|conversation-archived/u);
  assert.doesNotMatch(tab.containerEl.textContent, /Pi Session|JSONL|Catalog|软删除/u);
  const archiveRemove = tab.containerEl.querySelector<HTMLButtonElement>('button[aria-label="删除 归档会话样例"]')!;
  const modalCount = openTestModals.length;
  archiveRemove.click();
  const inlineConfirm = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-settings-inline-confirm");
  assert.ok(inlineConfirm, "archive deletion asks inside the row");
  assert.equal(openTestModals.length, modalCount, "archive confirmation does not open a modal");
  assert.match(inlineConfirm.textContent, /无法在设置中恢复/u);
  inlineConfirm.fireEvent("keydown", { key: "Escape" });
  assert.equal(tab.containerEl.querySelector(".echoink-settings-inline-confirm"), null);
  assert.equal(providerModalTestDocument.activeElement, archiveRemove);
  assert.equal(mutable.archivedConversations.length, 1, "cancelling keeps the archived conversation");
  const settingsTabSourceForArchivedConversation = readFileSync(
    "src/settings/settings-tab.ts",
    "utf8"
  );
  const archivedConversationActionStart = settingsTabSourceForArchivedConversation.indexOf(
    "private async softDeleteArchivedConversation"
  );
  const archivedConversationActionEnd = settingsTabSourceForArchivedConversation.indexOf(
    "\n  private removeArchivedConversation",
    archivedConversationActionStart
  );
  const archivedConversationActionSource = settingsTabSourceForArchivedConversation.slice(
    archivedConversationActionStart,
    archivedConversationActionEnd
  );
  assert.match(archivedConversationActionSource, /Conversation deleted\./u);
  assert.match(archivedConversationActionSource, /已删除会话/u);
  assert.doesNotMatch(archivedConversationActionSource, /Pi Session|JSONL|soft-delete|软删除/u);

  mutable.settingsDetail = "review-memory";
  mutable.personalMemoryState = identityState;
  tab.display();
  for (const label of ["事实", "观点", "决定", "进行中", "经历"]) {
    assert.match(tab.containerEl.textContent, new RegExp(label, "u"));
  }
  mutable.settingsDetail = {
    kind: "review-memory-category",
    category: "facts"
  };
  tab.display();
  assert.match(tab.containerEl.textContent, /当前事实/u);
  assert.match(tab.containerEl.textContent, /用户可见的事实正文/u);
  const correctionCard = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-memory-correction-row"
  );
  assert.ok(correctionCard, "the current Memory renders as one correction card");
  const cardHeader = correctionCard.querySelector<ProviderModalTestElement>(
    ".echoink-memory-card-header"
  );
  const cardFields = correctionCard.querySelector<ProviderModalTestElement>(
    ".echoink-memory-card-fields"
  );
  assert.ok(cardHeader && cardFields);
  assert.equal(correctionCard.children[0], cardHeader,
    "the title and Correct action stay in the first card layer");
  assert.equal(correctionCard.children[1], cardFields,
    "the readable Memory fields follow the header");
  assert.equal(
    cardHeader.querySelector(".echoink-memory-card-title")?.textContent,
    "当前事实"
  );
  assert.deepEqual(
    cardFields.querySelectorAll(".echoink-memory-card-label")
      .map((element) => element.textContent),
    ["记忆内容", "召回时机"]
  );
  assert.deepEqual(
    cardFields.querySelectorAll(".echoink-memory-card-body")
      .map((element) => element.textContent),
    ["用户可见的事实正文", "需要核对事实时"]
  );
  assert.deepEqual(
    cardFields.children.map((element) => element.className),
    [
      "echoink-memory-card-field echoink-memory-card-content",
      "echoink-memory-card-field echoink-memory-card-recall"
    ]
  );
  const correctionActions = correctionCard.querySelectorAll<ProviderModalTestElement>("button");
  assert.deepEqual(correctionActions.map((button) => button.textContent), ["修正", "忘掉"]);
  assert.equal(correctionActions[0]?.closest(".echoink-memory-card-header"), cardHeader);
  assert.equal(correctionActions[1]?.closest(".echoink-memory-card-header"), cardHeader);
  assert.equal(correctionActions[1]?.hasClass("mod-warning"), true);
  assert.equal(correctionCard.querySelectorAll("input, textarea, select").length, 0);
  assert.equal(
    correctionCard.querySelectorAll("*")
      .some((element) => element.className.includes("echoink-secondary-")),
    false
  );
  assert.doesNotMatch(
    correctionCard.textContent,
    /联想线索|AI 推断|Association clues|secondary/iu
  );
  assert.doesNotMatch(
    tab.containerEl.textContent,
    /mem_ui_private_id|private-source|records\/facts|revision/u
  );

  correctionActions[1]!.click();
  await settleMicrotasks();
  const cancelForget = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-settings-inline-confirm");
  assert.ok(cancelForget, "Review forget opens confirmation inside the card");
  assert.equal(openTestModals.length, modalCount);
  assert.match(cancelForget.textContent, /不会再被召回/u);
  const cancelForgetButton = cancelForget
    .querySelectorAll<ProviderModalTestElement>("button")
    .find((button) => button.textContent === "取消");
  assert.ok(cancelForgetButton);
  cancelForgetButton!.click();
  await settleMicrotasks();
  assert.equal(forgetCalls.length, 0, "canceling Review forget keeps zero writes");

  tab.display();
  const confirmForgetButton = tab.containerEl
    .querySelectorAll<ProviderModalTestElement>("button")
    .find((button) => button.textContent === "忘掉");
  assert.ok(confirmForgetButton);
  confirmForgetButton!.click();
  await settleMicrotasks();
  const confirmForget = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-settings-inline-confirm");
  assert.ok(confirmForget);
  const acceptForgetButton = confirmForget
    .querySelectorAll<ProviderModalTestElement>("button")
    .find((button) => button.hasClass("settings-danger"));
  assert.equal(acceptForgetButton?.textContent, "确认忘掉");
  acceptForgetButton!.click();
  await settleMicrotasks();
  assert.equal(forgetCalls.length, 1, "confirmed Review forget writes once");
  assert.equal(forgetCalls[0]?.[0], "mem_ui_private_id");
  assert.match(forgetCalls[0]?.[1] ?? "", /复盘记忆管理中明确要求忘掉/u);
  assert.equal(forgetCalls[0]?.[2], 1, "the host supplies the current revision");

  settings.settingsLanguage = "en";
  tab.display();
  const englishCard = tab.containerEl.querySelector<ProviderModalTestElement>(
    ".echoink-memory-correction-row"
  );
  assert.ok(englishCard);
  assert.deepEqual(
    englishCard.querySelectorAll(".echoink-memory-card-label")
      .map((element) => element.textContent),
    ["Memory content", "Recall when"]
  );
  assert.deepEqual(
    englishCard.querySelectorAll("button").map((button) => button.textContent),
    ["Correct", "Forget"]
  );
  assert.doesNotMatch(englishCard.textContent, /Association clues|AI inferred/iu);
  settings.settingsLanguage = "zh-CN";

  const correctionCss = readFileSync("styles.css", "utf8");
  const bodyRule = correctionCss.match(/\.echoink-memory-card-body\s*\{([^}]*)\}/u)?.[1] ?? "";
  assert.match(bodyRule, /max-inline-size:\s*68ch;/u);
  assert.match(bodyRule, /line-height:\s*1\.6;/u);
  assert.match(bodyRule, /overflow-wrap:\s*anywhere;/u);
  assert.match(bodyRule, /text-wrap:\s*pretty;/u);
  assert.doesNotMatch(bodyRule, /(?:^|;)\s*(?:width|height)\s*:/u);
  assert.match(
    correctionCss,
    /@container \(max-width:\s*360px\)\s*\{[\s\S]*?\.echoink-memory-card-header\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/u
  );
  assert.doesNotMatch(correctionCss, /\.echoink-secondary-/u);
  const settingsTabSource = readFileSync("src/settings/settings-tab.ts", "utf8");
  assert.doesNotMatch(
    settingsTabSource,
    /echoink-secondary-facts|listSecondaryForParent|renderSecondaryFactRow|openSecondaryFactEditor/u
  );

  settings.settingsTab = "general";
  mutable.settingsDetail = null;
  mutable.personalMemoryState = identityState;
  tab.display();
  assertSettingControlAccessibleName(tab.containerEl, "设置语言", "select");
  for (const label of ["启动时自动打开侧栏", "启动时自动打开首页"]) assertSettingsToggleAccessibleName(tab.containerEl, label);
  assert.equal(tab.containerEl.querySelector('input[aria-label="欢迎标题"]'), null);
  assert.equal(tab.containerEl.querySelector('input[aria-label="问候语"]'), null);
  const memoryHost = tab.containerEl.createDiv();
  const memory = new DesktopMemorySettings(plugin as never, { redraw() {}, openCorrection() {}, openProfile() {} });
  memory.render(memoryHost);
  assert.ok(memoryHost.querySelector('[aria-label="使用长期记忆"]'), "current Agent settings keep the accessible Memory switch");
  assert.ok(memoryHost.querySelector('[aria-label="空闲时整理记忆（做梦）"]'));
  memory.suspend(); memoryHost.remove();
  assert.doesNotMatch(
    tab.containerEl.textContent,
    /显示上下文容量|在对话顶部显示当前上下文容量|对话显示/u
  );
  settings.settingsLanguage = "en";
  tab.display();
  assert.doesNotMatch(
    tab.containerEl.textContent,
    /Show context usage|Show current context capacity and usage above conversations|conversation display/iu
  );
  settings.settingsLanguage = "zh-CN";
  tab.display();
  // Raw identity-file editors do not belong in the settings controls.
  assert.ok(!Array.from(tab.containerEl.querySelectorAll("button"))
    .some((button) => (button.getAttribute("aria-label") ?? "").includes("保存文件")));

  settings.settingsTab = "providers";
  mutable.settingsDetail = null;
  tab.display();
  const modelHost = tab.containerEl.createDiv();
  const previousDesktop = Platform.isDesktopApp;
  try {
    Platform.isDesktopApp = true;
    (tab as unknown as { renderDefaultModelSelector(parent: HTMLElement): void }).renderDefaultModelSelector(modelHost);
  } finally { Platform.isDesktopApp = previousDesktop; }
  assertSettingControlAccessibleName(modelHost, "EchoInk 默认模型", "select");
  assert.ok(modelHost.querySelector('[data-echoink-focus-key="models:default"]'));
  const modelOptions = Array.from(
    tab.containerEl.querySelectorAll<HTMLOptionElement>("option")
  );
  const optionForProvider = (providerId: string) => modelOptions.find((option) => {
    try {
      const value: unknown = JSON.parse(option.value);
      return Array.isArray(value) && value[0] === providerId;
    } catch {
      return false;
    }
  });
  assert.equal(
    optionForProvider(missingCredential.id)?.disabled,
    true
  );
  assert.equal(
    optionForProvider(credentialFree.id)?.disabled,
    false
  );
  assert.match(optionForProvider(provider.id)?.textContent ?? "", /^深度求索 · /u);
  assert.doesNotMatch(optionForProvider(provider.id)?.textContent ?? "", / \/ /u);
  assert.match(
    optionForProvider(customProvider.id)?.textContent ?? "",
    new RegExp(`^${customProvider.name} · `, "u")
  );
  assert.match(
    providerConnectionLabel(settings, "zh-CN"),
    /^深度求索 · /u
  );
  assert.match(
    providerConnectionLabel(settings, "en"),
    /^DeepSeek · /u
  );
  modelHost.remove();
  const historyHost = tab.containerEl.createDiv();
  const historyState = { date: "", page: 1, listScroll: 0 };
  let historyCleanup = () => {};
  let clearFocus = 0;
  const renderHistory = () => {
    historyCleanup(); historyHost.empty();
    historyCleanup = renderKnowledgeMaintenanceHistoryList(historyHost, {
      zh: settings.settingsLanguage !== "en", entries: settings.knowledgeBase.maintenanceHistory,
      records: [], state: historyState, onBack() {}, onChange: () => renderHistory(),
      onSelectRecord() {}, onUnavailable: () => { throw new Error("expected a real report path"); },
      onOpenPath: reportPath => openKnowledgeMaintenancePath(app, reportPath, settings.settingsLanguage !== "en"),
      onClearFocus: () => { clearFocus++; }
    });
  };
  renderHistory();
  const date = () => historyHost.querySelector<ProviderModalTestElement>('input[aria-label="维护日志日期筛选"]')!;
  const clear = () => historyHost.querySelector<ProviderModalTestElement>('button[aria-label="清除日期筛选"]')!;
  assert.equal(date().type, "date"); assert.equal(clear().disabled, true);
  assert.ok(historyHost.textContent.indexOf(maintenanceReportPath) < historyHost.textContent.indexOf(previousMaintenanceReportPath));
  historyHost.querySelectorAll<ProviderModalTestElement>("button").find(button => button.textContent === "查看明细")!.click();
  await settleMicrotasks(); assert.deepEqual(openedReports, [maintenanceReportPath]);
  historyState.page = 2; historyState.listScroll = 100;
  date().value = "2026-08-24"; date().onchange?.();
  assert.equal(historyState.page, 1); assert.equal(historyState.listScroll, 0);
  assert.match(historyHost.textContent, new RegExp(previousMaintenanceReportPath, "u"));
  assert.doesNotMatch(historyHost.textContent, new RegExp(maintenanceReportPath, "u"));
  date().value = "2026-08-23"; date().onchange?.();
  assert.match(historyHost.textContent, /所选日期没有维护记录/u); assert.equal(clear().disabled, false);
  clear().click(); assert.equal(clearFocus, 1); assert.equal(date().value, ""); assert.equal(clear().disabled, true);
  assert.match(historyHost.textContent, new RegExp(maintenanceReportPath, "u"));
  settings.knowledgeBase.maintenanceHistory = []; renderHistory();
  assert.match(historyHost.textContent, /还没有知识库维护记录/u); assert.doesNotMatch(historyHost.textContent, /所选日期没有维护记录/u);
  settings.settingsLanguage = "en"; renderHistory();
  assert.match(historyHost.textContent, /No Knowledge maintenance runs yet/u);
  assert.ok(historyHost.querySelector('input[aria-label="Maintenance log date filter"]'));
  assert.ok(historyHost.querySelector('button[aria-label="Clear date filter"]'));
  assert.doesNotMatch(historyHost.textContent, /长期记忆|Personal Memory/u);
  historyCleanup(); historyHost.remove(); settings.settingsLanguage = "zh-CN";
  assert.doesNotMatch(settingsTabSource, /knowledge-memory|addPersonalMemoryControl/u);
  tab.hide();
  assert.equal(providerModalResizeObservers.at(-1)?.disconnected, true);
}

function assertSettingControlAccessibleName(
  container: HTMLElement,
  label: string,
  selector: "input" | "select"
): void {
  const row = Array.from(container.querySelectorAll(".setting-item"))
    .find((candidate) => candidate.querySelector(".setting-item-name")?.textContent === label);
  assert.ok(row, `Expected setting row: ${label}`);
  assert.equal(row.querySelector(selector)?.getAttribute("aria-label"), label);
}

function assertSettingsToggleAccessibleName(
  container: HTMLElement,
  label: string
): void {
  const row = Array.from(container.querySelectorAll(".setting-item"))
    .find((candidate) => candidate.querySelector(".checkbox-container")?.getAttribute("aria-label") === label);
  assert.ok(row, `Expected toggle setting row: ${label}`);
  const toggle = row.querySelector<HTMLElement>(".checkbox-container");
  const input = toggle?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.equal(toggle?.getAttribute("aria-label"), label);
  assert.equal(input?.getAttribute("aria-label"), label);
  assert.equal(toggle?.getAttribute("tabindex"), null);
  assert.equal(input?.getAttribute("tabindex"), "0");
  const tabStops = row.querySelectorAll<HTMLElement>('[tabindex="0"]');
  assert.equal(tabStops.length, 1);
  assert.equal(tabStops[0], input);
}

function assertProviderScopedRollbackPreservesConcurrentSettings(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const old = createApiProviderConfig("deepseek", "rollback-old");
  settings.apiProviders = [old];
  activateApiProvider(settings, old);
  const snapshot = snapshotApiProviderSettings(settings);
  const candidate = createApiProviderConfig("deepseek", "rollback-candidate");
  settings.apiProviders = [candidate];
  activateApiProvider(settings, candidate);
  settings.settingsLanguage = "en";
  settings.customWelcomeEnabled = true;
  settings.customWelcomeSubtitle = "Concurrent greeting";
  restoreApiProviderSettings(settings, snapshot);
  assert.equal(settings.activeApiProviderId, old.id);
  assert.equal(settings.settingsLanguage, "en");
  assert.equal(settings.customWelcomeEnabled, true);
  assert.equal(settings.customWelcomeSubtitle, "Concurrent greeting");
}

async function assertMcpModalFieldAccessibility(): Promise<void> {
  installProviderModalDomFixture();
  const modal = new McpServerModal({
    app: new App(),
    language: "en",
    save: async () => undefined
  });
  modal.open();
  const save = modal.contentEl.querySelector<HTMLButtonElement>(
    '[data-mcp-modal-focus-key="save"]'
  );
  assert.ok(save);
  save.click();
  await flushProviderModalTasks();
  const name = modal.contentEl.querySelector<HTMLInputElement>(
    '[data-mcp-modal-focus-key="name"]'
  );
  assert.ok(name);
  assert.equal(name.getAttribute("aria-invalid"), "true");
  assert.equal(
    name.getAttribute("aria-describedby"),
    "echoink-mcp-server-name-error"
  );
  assert.equal(providerModalTestDocument.activeElement, name);
  modal.close();
}

async function assertProviderModalModelAccessibleNameIncludesValue(): Promise<void> {
  installProviderModalDomFixture();
  const provider = createApiProviderConfig("deepseek", "accessible-model");
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => ({
        status: "available",
        models: provider.models.map((model) => ({ id: model.id }))
      }),
      testConnection: async () => ({ status: "available" })
    },
    save: async () => ({ saved: true })
  });
  modal.open();
  const trigger = providerModalElementByFocusKey(modal, "model-discover");
  assert.ok(trigger);
  assert.equal(trigger.textContent, "Get models");
  assert.doesNotMatch(modal.contentEl.textContent, /\bAuto\b/u);
  const selected = primaryProviderModel(provider);
  assert.ok(providerModalElementByFocusKey(
    modal,
    `model-enabled:${selected.id}`
  ));
  assert.ok(providerModalElementByFocusKey(
    modal,
    `model-default:${selected.id}`
  ));
  providerModalElementByFocusKey(modal, "manual-model-add")?.click();
  assert.match(
    modal.contentEl.textContent,
    new RegExp(settingsCopy("en").providers.invalidModel, "u")
  );
  const manual = providerModalElementByFocusKey(modal, "manual-model");
  assert.ok(manual);
  manual.value = "manual-model-id";
  manual.oninput?.(new Event("input"));
  providerModalElementByFocusKey(modal, "manual-model-add")?.click();
  assert.equal(
    providerModalElementByFocusKey(
      modal,
      "model-enabled:manual-model-id"
    )?.checked,
    true
  );
  modal.close();
}

function assertProviderModelReasoningOverrideBoundary(): void {
  installProviderModalDomFixture();
  const catalogProvider = createApiProviderConfig(
    "deepseek",
    "catalog-reasoning-modal"
  );
  const catalogModel = primaryProviderModel(catalogProvider);
  catalogModel.metadataSource = "manual";
  catalogModel.reasoning = false;
  const normalizedCatalogProvider = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    settingsVersion: 52,
    apiProviders: [catalogProvider]
  }).settings.apiProviders[0];
  assert.ok(normalizedCatalogProvider);
  const normalizedCatalogModel = primaryProviderModel(
    normalizedCatalogProvider
  );
  assert.equal(normalizedCatalogModel.reasoning, true);

  const preflight = {
    listModels: async () => ({ status: "available" as const, models: [] }),
    testConnection: async () => ({ status: "available" as const })
  };
  const catalogModal = new ProviderModelModal({
    app: new App(),
    draft: normalizedCatalogProvider,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight,
    save: async () => ({ saved: true })
  });
  catalogModal.open();
  const catalogReasoning = providerModalElementByFocusKey(
    catalogModal,
    `toggle:model:${normalizedCatalogModel.id}:reasoning`
  );
  assert.ok(catalogReasoning, "Pi catalog models expose the user reasoning preference");
  assert.equal(catalogReasoning.checked, true);
  assert.equal(catalogReasoning.disabled, false);
  catalogReasoning.checked = false;
  catalogReasoning.onchange?.(new Event("change"));
  const editedCatalogModel = primaryProviderModel(
    (catalogModal as unknown as { draft: ApiProviderConfig }).draft
  );
  assert.equal(editedCatalogModel.reasoning, true);
  assert.equal(editedCatalogModel.reasoningEnabled, false);
  catalogModal.close();

  const unsupportedProvider = createApiProviderConfig(
    "custom",
    "unsupported-reasoning-modal"
  );
  unsupportedProvider.runtimeProviderId = "openai";
  const unsupportedModel = createApiProviderModelConfig(
    "custom",
    "gpt-4",
    unsupportedProvider.runtimeProviderId
  );
  unsupportedProvider.models = [unsupportedModel];
  unsupportedProvider.defaultModelId = unsupportedModel.id;
  const unsupportedModal = new ProviderModelModal({
    app: new App(),
    draft: unsupportedProvider,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight,
    save: async () => ({ saved: true })
  });
  unsupportedModal.open();
  const unsupportedReasoning = providerModalElementByFocusKey(
    unsupportedModal,
    `toggle:model:${unsupportedModel.id}:reasoning`
  );
  assert.ok(unsupportedReasoning);
  assert.equal(unsupportedReasoning.checked, false);
  assert.equal(unsupportedReasoning.disabled, true);
  assert.match(
    unsupportedModal.contentEl.textContent,
    /does not support deep reasoning/u
  );
  unsupportedModal.close();

  const manualProvider = createApiProviderConfig(
    "custom",
    "manual-reasoning-modal"
  );
  const manualModel = createApiProviderModelConfig(
    "custom",
    "manual-reasoner",
    manualProvider.runtimeProviderId
  );
  manualModel.metadataSource = "manual";
  manualModel.reasoning = false;
  manualProvider.models = [manualModel];
  manualProvider.defaultModelId = manualModel.id;
  const normalizedManualProvider = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    settingsVersion: 53,
    apiProviders: [manualProvider]
  }).settings.apiProviders[0];
  assert.ok(normalizedManualProvider);
  const normalizedManualModel = primaryProviderModel(
    normalizedManualProvider
  );
  assert.equal(normalizedManualModel.metadataSource, "manual");
  assert.equal(normalizedManualModel.reasoning, false);
  assert.equal(normalizedManualModel.reasoningEnabled, false);
  const manualModal = new ProviderModelModal({
    app: new App(),
    draft: normalizedManualProvider,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight,
    save: async () => ({ saved: true })
  });
  manualModal.open();
  const manualReasoning = providerModalElementByFocusKey(
    manualModal,
    `toggle:model:${normalizedManualModel.id}:reasoning`
  );
  assert.ok(manualReasoning);
  assert.equal(manualReasoning.checked, false);
  assert.equal(manualReasoning.disabled, false);
  manualReasoning.checked = true;
  manualReasoning.onchange?.(new Event("change"));
  const editedManualModel = primaryProviderModel(
    (manualModal as unknown as { draft: ApiProviderConfig }).draft
  );
  assert.equal(editedManualModel.reasoning, true);
  assert.equal(editedManualModel.reasoningEnabled, true);
  manualModal.close();
}
function assertSettingsV53MigrationContract(): void {
  const failures: Error[] = [];
  const check = (label: string, assertion: () => void): void => {
    try {
      assertion();
    } catch (error) {
      failures.push(new Error(label, { cause: error }));
    }
  };

  check("fresh install does not select a Provider without a usable API Key", () => {
    assert.equal(DEFAULT_SETTINGS.settingsVersion, 54);
    assert.equal(DEFAULT_SETTINGS.activeApiProviderId, "");
    assert.equal(DEFAULT_SETTINGS.memory.useLongTermMemory, true);
    assert.equal(DEFAULT_SETTINGS.memory.dreamEnabled, true);
    assert.equal(normalizeSettingsData(undefined).settings.memory.dreamEnabled, true);
    assert.equal(normalizeSettingsData(undefined).settings.journalDirectory, "journal");
    assert.equal(normalizeSettingsData({ journalDirectory: "" }).settings.journalDirectory, "journal");
    assert.equal(normalizeSettingsData({ journalDirectory: "../outside" }).settings.journalDirectory, "journal");
    assert.equal(
      normalizeSettingsData({ journalDirectory: " Notes\\Daily// " }).settings.journalDirectory,
      "Notes/Daily"
    );
    assert.equal(normalizeSettingsData({ memory: {} }).settings.memory.dreamEnabled, true);
    assert.equal(
      normalizeSettingsData({ memory: { dreamEnabled: false } }).settings.memory.dreamEnabled,
      false,
      "an explicitly disabled Dream setting survives normalization on restart"
    );
    assert.equal(
      normalizeSettingsData(undefined).settings.activeApiProviderId,
      ""
    );
    assert.equal(
      normalizeSettingsData({ memory: { enabled: false } }).settings.memory.useLongTermMemory,
      true
    );
    assert.equal(
      normalizeSettingsData({ memory: { enabled: true, useLongTermMemory: false } }).settings.memory.useLongTermMemory,
      false
    );
  });

  check("retired context display setting is dropped without hiding the Composer meter", () => {
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      showContext: false
    });
    assert.equal(normalized.changed, true);
    assert.equal(Object.hasOwn(normalized.settings, "showContext"), false);
  });

  check("v50 flat and auto Provider settings migrate to one explicit enabled default model", () => {
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 50,
      defaultReasoning: "high",
      activeApiProviderId: "legacy-custom",
      defaultModel: "legacy-model",
      apiProviders: [{
        id: "legacy-custom",
        providerId: "custom",
        runtimeProviderId: "legacy-runtime",
        apiProtocol: "openai-completions",
        authMode: "api-key",
        name: "Legacy custom",
        baseUrl: "https://legacy.example/v1",
        model: "legacy-model",
        models: ["legacy-model", "unselected-discovery-result"],
        modelSelection: "auto",
        toolCalling: true,
        imageInput: true,
        reasoning: true,
        contextWindow: 96_000,
        maxOutputTokens: 12_000,
        apiKey: "fixture-key"
      }]
    }).settings;
    const provider = normalized.apiProviders[0];
    assert.ok(provider);
    assert.equal(provider.defaultModelId, "legacy-model");
    assert.equal(normalized.defaultModel, "legacy-model");
    assert.deepEqual(provider.models.map((model) => model.id), ["legacy-model"]);
    assert.deepEqual(provider.models[0], {
      id: "legacy-model",
      displayName: "legacy-model",
      input: ["text", "image"],
      toolCalling: true,
      reasoning: true,
      reasoningEnabled: true,
      reasoningEffort: "high",
      contextWindow: 96_000,
      modelMaxTokens: 12_000,
      maxOutputTokens: 12_000,
      limitsOverride: {
        contextWindow: 96_000,
        modelMaxTokens: 12_000,
        maxOutputTokens: 12_000
      },
      metadataSource: "manual"
    });
    for (const retired of [
      "model",
      "modelSelection",
      "toolCalling",
      "imageInput",
      "reasoning",
      "contextWindow",
      "maxOutputTokens"
    ]) {
      assert.equal(Object.hasOwn(provider, retired), false, retired);
    }
  });

  check("v51 preserves an active non-default enabled Composer model", () => {
    const provider = createApiProviderConfig("deepseek", "current-multi-model");
    provider.name = "Current multi-model";
    provider.apiKey = "fixture-key";
    replaceProviderModels(
      provider,
      "deepseek-v4-flash",
      "deepseek-v4-pro"
    );
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 51,
      defaultReasoning: "high",
      activeApiProviderId: provider.id,
      defaultModel: "deepseek-v4-pro",
      apiProviders: [provider]
    }).settings;
    assert.equal(normalized.activeApiProviderId, provider.id);
    assert.equal(normalized.apiProviders[0]?.defaultModelId, "deepseek-v4-flash");
    assert.equal(normalized.defaultModel, "deepseek-v4-pro");
    assert.equal(Object.hasOwn(normalized, "defaultReasoning"), false);
    assert.equal(
      normalized.apiProviders[0]?.models.find(
        (model) => model.id === "deepseek-v4-pro"
      )?.reasoningEffort,
      "high"
    );
    assert.equal(
      normalized.apiProviders[0]?.models.find(
        (model) => model.id === "deepseek-v4-pro"
      )?.reasoningEnabled,
      true
    );
    assert.equal(
      normalized.apiProviders[0]?.models.find(
        (model) => model.id === "deepseek-v4-flash"
      )?.reasoningEffort,
      undefined
    );
    assert.equal(
      normalized.apiProviders[0]?.models.find(
        (model) => model.id === "deepseek-v4-flash"
      )?.reasoningEnabled,
      true
    );
  });

  check("new reasoning models default to deep reasoning enabled", () => {
    const model = createApiProviderModelConfig("deepseek", "deepseek-v4-pro");
    assert.equal(model.reasoning, true);
    assert.equal(model.reasoningEnabled, true);
    assert.equal(model.reasoningEffort, undefined);
  });

  check("v52 positive reasoning strengths migrate to enabled and retain their wire value", () => {
    const efforts = [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ] as const;
    for (const effort of efforts) {
      const provider = createApiProviderConfig("deepseek", `roundtrip-${effort}`);
      const model = primaryProviderModel(provider);
      model.reasoningEffort = effort;
      delete (model as Partial<ApiProviderModelConfig>).reasoningEnabled;
      const reopened = normalizeSettingsData({
        ...structuredClone(DEFAULT_SETTINGS),
        settingsVersion: 52,
        apiProviders: [provider]
      }).settings.apiProviders[0]?.models[0];
      assert.equal(reopened?.reasoningEnabled, true);
      assert.equal(reopened?.reasoningEffort, effort);
    }
  });

  check("v52 none migrates to disabled and is removed from strength storage", () => {
    const provider = createApiProviderConfig("deepseek", "migrate-none");
    const model = primaryProviderModel(provider);
    delete (model as Partial<ApiProviderModelConfig>).reasoningEnabled;
    model.reasoningEffort = "none";
    const reopened = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [provider]
    }).settings.apiProviders[0]?.models[0];
    assert.equal(reopened?.reasoningEnabled, false);
    assert.equal(reopened?.reasoningEffort, undefined);
  });

  check("v52 manual reasoning capability remains enabled without a stored strength", () => {
    const provider = createApiProviderConfig("custom", "legacy-manual-reasoning");
    const model = createApiProviderModelConfig(
      "custom",
      "manual-reasoner",
      provider.runtimeProviderId
    );
    model.metadataSource = "manual";
    model.reasoning = true;
    delete (model as Partial<ApiProviderModelConfig>).reasoningEnabled;
    provider.models = [model];
    provider.defaultModelId = model.id;
    const reopened = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [provider]
    }).settings.apiProviders[0]?.models[0];
    assert.equal(reopened?.reasoning, true);
    assert.equal(reopened?.reasoningEnabled, true);
  });

  check("v53 explicit disable retains the last positive strength for re-enable", () => {
    const provider = createApiProviderConfig("deepseek", "disabled-last-strength");
    const model = primaryProviderModel(provider);
    model.reasoningEnabled = false;
    model.reasoningEffort = "high";
    const disabled = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 53,
      apiProviders: [provider]
    }).settings.apiProviders[0]?.models[0];
    assert.equal(disabled?.reasoningEnabled, false);
    assert.equal(disabled?.reasoningEffort, "high");
    assert.ok(disabled);
    disabled.reasoningEnabled = true;
    const enabled = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 53,
      apiProviders: [{ ...provider, models: [disabled] }]
    }).settings.apiProviders[0]?.models[0];
    assert.equal(enabled?.reasoningEnabled, true);
    assert.equal(enabled?.reasoningEffort, "high");
  });

  check("v53 explicit disable is preserved for an unknown reasoning model", () => {
    const provider = createApiProviderConfig("custom", "disabled-unknown-reasoning");
    const model = createApiProviderModelConfig(
      "custom",
      "provider-newer-than-catalog",
      provider.runtimeProviderId
    );
    model.reasoningEnabled = false;
    provider.models = [model];
    provider.defaultModelId = model.id;
    const reopened = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 53,
      apiProviders: [provider]
    }).settings.apiProviders[0]?.models[0];
    assert.equal(reopened?.reasoning, true);
    assert.equal(reopened?.reasoningEnabled, false);
  });

  check("invalid stored reasoning preference is not admitted", () => {
    const provider = createApiProviderConfig("deepseek", "invalid-effort");
    const model = primaryProviderModel(provider) as ApiProviderModelConfig & {
      reasoningEffort: string;
    };
    model.reasoningEffort = "turbo";
    delete (model as Partial<ApiProviderModelConfig>).reasoningEnabled;
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [provider]
    }).settings;
    const reopened = normalized.apiProviders[0]?.models[0];
    assert.ok(reopened);
    assert.equal(reopened?.reasoningEffort, undefined);
    assert.equal(
      apiProviderModelHadInvalidStoredReasoningEffort(provider.id, reopened),
      true
    );
    assert.equal(
      resolveComposerReasoningState(normalized, provider.id, reopened.id)?.status,
      "invalid"
    );
    const cloned = structuredClone(normalized);
    assert.equal(
      resolveComposerReasoningState(cloned, provider.id, reopened.id)?.status,
      "invalid",
      "the invalid-value signal must survive Provider activation clones"
    );
    const serialized = JSON.stringify(normalized);
    assert.doesNotMatch(serialized, /turbo/u);
    assert.doesNotMatch(serialized, /invalidStoredReasoning/u);
  });

  check("missing stored reasoning preference remains distinct from invalid", () => {
    const provider = createApiProviderConfig("deepseek", "missing-effort");
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [provider]
    }).settings;
    const reopened = normalized.apiProviders[0]?.models[0];
    assert.ok(reopened);
    assert.equal(
      apiProviderModelHadInvalidStoredReasoningEffort(provider.id, reopened),
      false
    );
    assert.equal(
      resolveComposerReasoningState(normalized, provider.id, reopened.id)?.status,
      "missing"
    );
  });

  check("only an explicit valid value clears an invalid identity signal", () => {
    const provider = createApiProviderConfig("deepseek", "repaired-effort");
    const model = primaryProviderModel(provider) as ApiProviderModelConfig & {
      reasoningEffort: string;
    };
    model.reasoningEffort = "turbo";
    delete (model as Partial<ApiProviderModelConfig>).reasoningEnabled;
    const invalid = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [provider]
    }).settings;
    const invalidModel = invalid.apiProviders[0]?.models[0];
    assert.ok(invalidModel);
    assert.equal(
      apiProviderModelHadInvalidStoredReasoningEffort(provider.id, invalidModel),
      true
    );

    const normalizedAgain = normalizeSettingsData(invalid).settings;
    const normalizedAgainModel = normalizedAgain.apiProviders[0]?.models[0];
    assert.ok(normalizedAgainModel);
    assert.equal(normalizedAgainModel.reasoningEffort, undefined);
    assert.equal(
      apiProviderModelHadInvalidStoredReasoningEffort(
        provider.id,
        normalizedAgainModel
      ),
      true
    );
    assert.equal(
      resolveComposerReasoningState(
        normalizedAgain,
        provider.id,
        normalizedAgainModel.id
      )?.status,
      "invalid"
    );

    normalizedAgainModel.reasoningEffort = "max";
    const repaired = normalizeSettingsData(normalizedAgain).settings;
    const repairedModel = repaired.apiProviders[0]?.models[0];
    assert.ok(repairedModel);
    assert.equal(repairedModel.reasoningEffort, "max");
    assert.equal(
      apiProviderModelHadInvalidStoredReasoningEffort(provider.id, repairedModel),
      false
    );
    assert.equal(
      resolveComposerReasoningState(
        repaired,
        provider.id,
        repairedModel.id
      )?.status,
      "valid"
    );

  });

  check("catalog reasoning truth overrides a stored manual flag", () => {
    const provider = createApiProviderConfig("deepseek", "catalog-reasoning");
    const model = primaryProviderModel(provider);
    assert.equal(model.reasoning, true);
    model.metadataSource = "manual";
    model.reasoning = false;
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [provider]
    }).settings;
    const reopened = normalized.apiProviders[0]?.models[0];
    assert.ok(reopened);
    assert.equal(reopened.metadataSource, "manual");
    assert.equal(reopened.reasoning, true);
  });

  check("v51 protocol migration preserves compatibility identities safely", () => {
    const provider = (
      id: string,
      providerId: "custom" | "anthropic" | "openai",
      apiProtocol: string
    ) => ({
      id,
      providerId,
      runtimeProviderId: providerId,
      apiProtocol,
      authMode: "api-key",
      name: providerId,
      baseUrl: providerId === "anthropic"
        ? "https://api.anthropic.com"
        : providerId === "openai"
          ? "https://api.openai.com/v1"
          : "https://custom.example/v1",
      models: [],
      defaultModelId: "",
      apiKey: "fixture-key"
    });
    const migrated = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 51,
      apiProviders: [
        provider("legacy-custom-codex", "custom", "openai-codex-responses"),
        provider("legacy-anthropic", "anthropic", "openai-completions"),
        provider("legacy-openai-responses", "openai", "openai-responses"),
        provider("legacy-openai-codex", "openai", "openai-codex-responses")
      ]
    }).settings.apiProviders;
    assert.deepEqual(
      migrated.map((entry) => [entry.providerId, entry.apiProtocol]),
      [
        ["custom", "openai-completions"],
        ["anthropic", "anthropic-messages"],
        ["openai", "openai-responses"],
        ["openai", "openai-completions"]
      ]
    );
  });

  check("exact legacy Token Plan custom settings migrate without losing model state", () => {
    const providerSettingsId = "legacy-token-plan-custom";
    const modelId = "fixture-token-plan-model";
    const apiKey = "fixture-token-plan-migration-key";
    const legacyProvider = {
      id: providerSettingsId,
      providerId: "custom",
      runtimeProviderId: "echoink-custom",
      apiProtocol: "openai-responses",
      authMode: "oauth",
      name: "自定义 / Custom",
      baseUrl: QWEN_TOKEN_PLAN_API_BASE_URL,
      models: [{
        id: modelId,
        displayName: "Fixture Token Plan Model",
        input: ["text", "image"],
        toolCalling: true,
        reasoning: true,
        reasoningEffort: "max",
        contextWindow: 128_000,
        modelMaxTokens: 64_000,
        maxOutputTokens: 16_000,
        limitsOverride: {
          contextWindow: 128_000,
          modelMaxTokens: 64_000,
          maxOutputTokens: 16_000
        },
        metadataSource: "manual"
      }],
      defaultModelId: modelId,
      apiKey
    };
    const migration = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      activeApiProviderId: providerSettingsId,
      defaultModel: modelId,
      apiProviders: [legacyProvider]
    });
    assert.equal(migration.changed, true);
    const normalized = migration.settings;
    const migrated = normalized.apiProviders[0];
    assert.ok(migrated);
    assert.equal(migrated.id, providerSettingsId);
    assert.equal(migrated.providerId, "qwen-token-plan");
    assert.equal(migrated.runtimeProviderId, "qwen-token-plan-cn");
    assert.equal(migrated.apiProtocol, "openai-completions");
    assert.equal(migrated.authMode, "api-key");
    assert.equal(
      migrated.name,
      getApiProviderPreset("qwen-token-plan").name
    );
    assert.equal(migrated.apiKey, apiKey);
    assert.equal(migrated.defaultModelId, modelId);
    assert.equal(normalized.activeApiProviderId, providerSettingsId);
    assert.equal(normalized.defaultModel, modelId);
    assert.deepEqual(migrated.models, [{
      ...legacyProvider.models[0],
      reasoningEnabled: true
    }]);
    assert.equal(resolveConfiguredPiProviderTransportKind({
      providerId: migrated.providerId ?? "custom",
      runtimeProviderId: migrated.runtimeProviderId,
      apiProtocol: migrated.apiProtocol,
      baseUrl: migrated.baseUrl
    }), "qwen-token-plan");
    assert.equal(
      normalizeSettingsData(structuredClone(normalized)).changed,
      false
    );

    const similar = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [{
        ...legacyProvider,
        id: "similar-custom-provider",
        baseUrl: `${QWEN_TOKEN_PLAN_API_BASE_URL}/models`
      }]
    }).settings.apiProviders[0];
    assert.ok(similar);
    assert.equal(similar.providerId, "custom");
    assert.equal(similar.runtimeProviderId, "echoink-custom");
    assert.equal(resolveConfiguredPiProviderTransportKind({
      providerId: similar.providerId ?? "custom",
      runtimeProviderId: similar.runtimeProviderId,
      apiProtocol: similar.apiProtocol,
      baseUrl: similar.baseUrl
    }), "default");

    const emptyName = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [{
        ...legacyProvider,
        id: "empty-name-token-plan",
        name: " "
      }]
    }).settings.apiProviders[0];
    assert.equal(
      emptyName?.name,
      getApiProviderPreset("qwen-token-plan").name
    );

    const customName = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [{
        ...legacyProvider,
        id: "named-token-plan",
        name: "My Token Plan"
      }]
    }).settings.apiProviders[0];
    assert.equal(customName?.providerId, "qwen-token-plan");
    assert.equal(customName?.name, "My Token Plan");
  });

  check("v51 manual limits migrate with legacy clamping and remain idempotent", () => {
    const general = createApiProviderConfig("custom", "legacy-general-limits");
    general.baseUrl = "https://legacy-general.example/v1";
    general.models = [{
      ...createApiProviderModelConfig("custom", "legacy-general-model"),
      contextWindow: 96_000,
      modelMaxTokens: 12_000,
      maxOutputTokens: 12_000,
      metadataSource: "manual"
    }];
    general.defaultModelId = "legacy-general-model";

    const kimi = createApiProviderConfig("kimi", "legacy-kimi-limits");
    kimi.models = [{
      ...createApiProviderModelConfig(
        "kimi",
        "kimi-k2.7-code",
        kimi.runtimeProviderId
      ),
      contextWindow: 262_144,
      modelMaxTokens: 200_000,
      maxOutputTokens: 200_000,
      metadataSource: "manual"
    }];
    kimi.defaultModelId = "kimi-k2.7-code";

    const once = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 51,
      apiProviders: [general, kimi]
    }).settings;
    assert.deepEqual(once.apiProviders[0]?.models[0]?.limitsOverride, {
      contextWindow: 96_000,
      modelMaxTokens: 12_000,
      maxOutputTokens: 12_000
    });
    assert.deepEqual(once.apiProviders[1]?.models[0]?.limitsOverride, {
      modelMaxTokens: 200_000
    });
    assert.equal(once.apiProviders[1]?.models[0]?.maxOutputTokens, 65_536);

    const twice = normalizeSettingsData(structuredClone(once)).settings;
    assert.deepEqual(twice.apiProviders, once.apiProviders);
  });

  check("unknown model metadata defaults to tools and deep reasoning while image input stays conservative", () => {
    const unknown = createApiProviderModelConfig("custom", "undocumented-model");
    assert.deepEqual(unknown.input, ["text"]);
    assert.equal(unknown.toolCalling, true);
    assert.equal(unknown.reasoning, true);
    assert.equal(unknown.reasoningEnabled, true);
    assert.equal(unknown.metadataSource, "unknown");
  });

  check("v52 keeps empty per-field limits inherited instead of persisting overrides", () => {
    const provider = createApiProviderConfig("deepseek", "limits-v52");
    const model = primaryProviderModel(provider);
    const baseline = structuredClone(model);
    model.toolCalling = !model.toolCalling;
    model.metadataSource = "manual";
    const reopened = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 52,
      apiProviders: [provider]
    }).settings.apiProviders[0]?.models[0];
    assert.ok(reopened);
    assert.equal(Object.hasOwn(reopened, "limitsOverride"), false);
    assert.equal(reopened.contextWindow, baseline.contextWindow);
    assert.equal(reopened.modelMaxTokens, baseline.modelMaxTokens);
    assert.equal(reopened.maxOutputTokens, baseline.maxOutputTokens);
    assert.equal(reopened.toolCalling, model.toolCalling);
  });

  check("per-field limits override only the entered values and clear independently", () => {
    const provider = createApiProviderConfig("deepseek", "partial-limits-v52");
    const model = primaryProviderModel(provider);
    const baseline = structuredClone(model);
    applyApiProviderModelLimitsOverride(
      model,
      "deepseek",
      provider.runtimeProviderId,
      { contextWindow: 120_000 }
    );
    assert.deepEqual(model.limitsOverride, { contextWindow: 120_000 });
    assert.equal(model.contextWindow, 120_000);
    assert.equal(model.modelMaxTokens, baseline.modelMaxTokens);
    assert.equal(
      model.maxOutputTokens,
      Math.min(120_000, baseline.maxOutputTokens)
    );

    applyApiProviderModelLimitsOverride(
      model,
      "deepseek",
      provider.runtimeProviderId,
      {}
    );
    assert.equal(Object.hasOwn(model, "limitsOverride"), false);
    assert.equal(model.contextWindow, baseline.contextWindow);
    assert.equal(model.modelMaxTokens, baseline.modelMaxTokens);
    assert.equal(model.maxOutputTokens, baseline.maxOutputTokens);
  });

  check("limits equal to reliable model metadata are pruned while real overrides remain", () => {
    const provider = createApiProviderConfig("deepseek", "redundant-limits-v53");
    const model = primaryProviderModel(provider);
    const baseline = structuredClone(model);
    applyApiProviderModelLimitsOverride(
      model,
      "deepseek",
      provider.runtimeProviderId,
      {
        contextWindow: baseline.contextWindow,
        modelMaxTokens: baseline.modelMaxTokens,
        maxOutputTokens: baseline.maxOutputTokens
      }
    );
    assert.equal(Object.hasOwn(model, "limitsOverride"), false);

    applyApiProviderModelLimitsOverride(
      model,
      "deepseek",
      provider.runtimeProviderId,
      {
        contextWindow: baseline.contextWindow + 1_024,
        modelMaxTokens: baseline.modelMaxTokens,
        maxOutputTokens: baseline.maxOutputTokens
      }
    );
    assert.deepEqual(model.limitsOverride, {
      contextWindow: baseline.contextWindow + 1_024
    });
    assert.equal(model.contextWindow, baseline.contextWindow + 1_024);
    assert.equal(model.modelMaxTokens, baseline.modelMaxTokens);
    assert.equal(model.maxOutputTokens, baseline.maxOutputTokens);

    applyApiProviderModelLimitsOverride(
      model,
      "deepseek",
      provider.runtimeProviderId,
      {
        modelMaxTokens: 120_000,
        maxOutputTokens: baseline.maxOutputTokens + 1
      }
    );
    assert.deepEqual(model.limitsOverride, {
      modelMaxTokens: 120_000
    });
    assert.equal(model.modelMaxTokens, 120_000);
    assert.equal(model.maxOutputTokens, 120_000);
  });

  check("discovered IDs use exact runtime Provider metadata from the Pi catalog", () => {
    const catalog = MOONSHOTAI_CN_MODELS["kimi-k2.7-code"];
    assert.ok(catalog);
    assert.equal(Object.hasOwn(catalog, "toolCalling"), false);
    const discovered = createApiProviderModelConfig(
      "kimi",
      catalog.id,
      "moonshotai-cn"
    );
    assert.deepEqual(discovered, {
      id: catalog.id,
      displayName: catalog.name,
      input: catalog.input.includes("image")
        ? ["text", "image"]
        : ["text"],
      toolCalling: true,
      reasoning: catalog.reasoning,
      reasoningEnabled: catalog.reasoning,
      contextWindow: catalog.contextWindow,
      modelMaxTokens: catalog.maxTokens,
      maxOutputTokens: 65_536,
      metadataSource: "catalog"
    });
    const provider = createApiProviderConfig("kimi", "catalog-provider");
    provider.models = [discovered];
    provider.defaultModelId = discovered.id;
    const reopened = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 51,
      apiProviders: [provider]
    }).settings.apiProviders[0]?.models[0];
    assert.deepEqual(reopened, discovered);
    const sameIdWrongProvider = createApiProviderModelConfig(
      "custom",
      catalog.id,
      "deepseek"
    );
    assert.equal(sameIdWrongProvider.metadataSource, "unknown");
    assert.deepEqual(sameIdWrongProvider.input, ["text"]);
    assert.equal(sameIdWrongProvider.toolCalling, true);
    assert.equal(sameIdWrongProvider.reasoning, true);
    assert.equal(sameIdWrongProvider.reasoningEnabled, true);
  });

  check("v48 drops retired Provider references and requires API Key re-entry", () => {
    const uncredentialed = createApiProviderConfig("deepseek", "uncredentialed");
    const legacy = {
      ...uncredentialed,
      providerRef: `provider-${"a".repeat(32)}`,
      credentialRef: `cred-${"b".repeat(32)}`
    };
    const unavailable = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 48,
      activeApiProviderId: uncredentialed.id,
      apiProviders: [legacy]
    }).settings;
    assert.equal(unavailable.activeApiProviderId, "");
    assert.equal(unavailable.apiProviders[0]?.apiKey, "");
    assert.equal(
      Object.hasOwn(unavailable.apiProviders[0] ?? {}, "providerRef"),
      false
    );
    assert.equal(
      Object.hasOwn(unavailable.apiProviders[0] ?? {}, "credentialRef"),
      false
    );

    const configured = createApiProviderConfig("deepseek", "configured");
    configured.apiKey = "persisted-provider-api-key";
    const available = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 49,
      activeApiProviderId: configured.id,
      apiProviders: [configured]
    }).settings;
    assert.equal(available.activeApiProviderId, configured.id);
    assert.equal(available.apiProviders[0]?.apiKey, configured.apiKey);
    assert.equal(available.apiProviders[0]?.authMode, "api-key");
  });

  check("v49 adds explicit Codex OAuth without weakening API-key Providers", () => {
    const apiKeyProvider = createApiProviderConfig("deepseek", "api-key-v49");
    apiKeyProvider.apiKey = "fixture-provider-key";
    const codexProvider = {
      ...createApiProviderConfig("openai-codex", "codex-v49"),
      authMode: undefined,
      apiProtocol: "openai-completions",
      apiKey: "must-not-be-used-as-codex-auth"
    };
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 49,
      activeApiProviderId: apiKeyProvider.id,
      apiProviders: [apiKeyProvider, codexProvider]
    }).settings;
    assert.equal(normalized.apiProviders[0]?.authMode, "api-key");
    assert.equal(
      normalized.apiProviders[0]?.apiKey,
      "fixture-provider-key"
    );
    assert.equal(normalized.apiProviders[1]?.authMode, "oauth");
    assert.equal(
      normalized.apiProviders[1]?.apiProtocol,
      "openai-codex-responses"
    );
    assert.equal(normalized.apiProviders[1]?.apiKey, "");
    assert.equal(normalized.openAICodexCredential, null);
    assert.equal(normalized.activeApiProviderId, apiKeyProvider.id);
  });

  check("v48 drops retired Knowledge scheduling state but preserves Review scheduling", () => {
    const result = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 48,
      knowledgeBase: {
        ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
        enabled: true,
        scheduleTime: "08:30",
        catchUpOnStartup: false,
        lastScheduledRunAt: 101,
        lastScheduledRunStatus: "success",
        lastScheduledRunId: "legacy-run",
        scheduledAttemptCount: 2,
        scheduledNextRetryAt: 202
      },
      review: {
        ...structuredClone(DEFAULT_SETTINGS.review),
        enabled: true,
        scheduleTime: "22:15",
        catchUpOnStartup: false,
        reports: {
          knowledgeBase: {
            lastRangeKey: "2026-08-03-to-2026-08-09",
            lastRunAt: 101,
            lastRunStatus: "success",
            lastMarkdownPath: "outputs/legacy.md",
            lastHtmlPath: "outputs/legacy.html",
            lastError: "legacy",
            lastSummary: "legacy"
          },
          agentChat: {
            lastRangeKey: ""
          }
        }
      },
      agents: {
        hermes: { apiKey: "sentinel-not-a-real-key" }
      }
    });
    const normalized = result.settings;
    assert.equal(result.changed, true);
    const knowledge = normalized.knowledgeBase as unknown as Record<string, unknown>;
    for (const key of [
      "scheduleTime",
      "catchUpOnStartup",
      "lastScheduledRunAt",
      "lastScheduledRunStatus",
      "lastScheduledRunId",
      "scheduledAttemptCount",
      "scheduledNextRetryAt"
    ]) {
      assert.equal(Object.hasOwn(knowledge, key), false, key);
    }
    assert.equal(normalized.review.scheduleTime, "22:15");
    assert.equal(normalized.review.catchUpOnStartup, false);
    assert.equal(normalized.review.enabled, true);
    assert.deepEqual(normalized.review.reports.knowledgeBase, {
      lastRangeKey: "2026-08-03-to-2026-08-09"
    });
    assert.deepEqual(normalized.review.reports.agentChat, {
      lastRangeKey: ""
    });
    assert.equal(
      JSON.stringify(normalized).includes("sentinel-not-a-real-key"),
      false
    );
    assert.equal(
      Object.hasOwn(normalized as unknown as Record<string, unknown>, "agents"),
      false
    );
  });

  check("retired LLM-WIKI settings are removed without touching current Knowledge state", () => {
    const legacyInput: unknown = {
      ...structuredClone(DEFAULT_SETTINGS),
      knowledgeBase: {
        ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
        useCustomRulesFile: true,
        rulesFilePath: "LLM-WIKI.md",
        initialization: {
          ...structuredClone(DEFAULT_SETTINGS.knowledgeBase.initialization),
          rulesFilePath: "LLM-WIKI.md"
        }
      }
    };
    const result = normalizeSettingsData(legacyInput);
    assert.equal(result.changed, true);
    assert.equal(
      Object.hasOwn(result.settings.knowledgeBase, "useCustomRulesFile"),
      false
    );
    assert.equal(
      Object.hasOwn(result.settings.knowledgeBase, "rulesFilePath"),
      false
    );
    assert.equal(
      Object.hasOwn(result.settings.knowledgeBase.initialization, "rulesFilePath"),
      false
    );

    const nestedOnly = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      knowledgeBase: {
        ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
        initialization: {
          ...structuredClone(DEFAULT_SETTINGS.knowledgeBase.initialization),
          rulesFilePath: "LLM-WIKI.md"
        }
      }
    });
    assert.equal(nestedOnly.changed, true);
    assert.equal(
      Object.hasOwn(nestedOnly.settings.knowledgeBase.initialization, "rulesFilePath"),
      false
    );
  });

  check("legacy resource scope overrides collapse to one false-wins global switch", () => {
    const resource = {
      id: "skill-false-wins",
      kind: "skill" as const,
      source: "manual" as const,
      name: "False wins",
      description: "migration fixture",
      enabled: true,
      scopes: ["chat", "knowledge", "editor-actions"] as const,
      bridgeMode: "prompt-only" as const,
      contentPath: "skills/false-wins/SKILL.md"
    };
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 47,
      resources: {
        ...structuredClone(DEFAULT_SETTINGS.resources),
        catalog: [resource],
        enabledByScope: {
          chat: { [resource.id]: true },
          knowledge: { [resource.id]: false },
          "editor-actions": {}
        }
      }
    }).settings;
    const resources = normalized.resources as unknown as Record<string, unknown>;
    const migrated = (resources.catalog as Array<Record<string, unknown>>)[0];
    assert.equal(migrated?.enabled, false);
    assert.equal(Object.hasOwn(resources, "enabledByScope"), false);
    assert.equal(Object.hasOwn(migrated ?? {}, "scopes"), false);
  });

  check("v47 overrides-only false remains closed when a Vault Skill is rediscovered", () => {
    const resourceId = "echoink-local:skill:vault-only-fixture";
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 47,
      resources: {
        ...structuredClone(DEFAULT_SETTINGS.resources),
        catalog: [],
        enabledByScope: {
          chat: { [resourceId]: true },
          knowledge: { [resourceId]: false },
          "editor-actions": {}
        }
      }
    }).settings;
    assert.deepEqual(normalized.resources.catalog, []);
    assert.equal(normalized.resources.legacyEnabledOverrides?.[resourceId], false);
    const merged = buildActiveEchoInkResourceCatalog({
      settings: normalized.resources,
      manual: [{
        id: resourceId,
        kind: "skill",
        source: "echoink-local",
        name: "Rediscovered fixture",
        description: "",
        enabled: true,
        bridgeMode: "prompt-only",
        contentPath: "skills/rediscovered/SKILL.md"
      }]
    });
    assert.equal(merged[0]?.enabled, false);
  });

  check("v47 overrides-only true remains enabled over a disabled Vault binding", () => {
    const resourceId = "echoink-local:skill:vault-true-fixture";
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 47,
      resources: {
        ...structuredClone(DEFAULT_SETTINGS.resources),
        catalog: [],
        enabledByScope: {
          chat: { [resourceId]: true },
          knowledge: {},
          "editor-actions": {}
        }
      }
    }).settings;
    const merged = buildActiveEchoInkResourceCatalog({
      settings: normalized.resources,
      manual: [{
        id: resourceId,
        kind: "skill",
        source: "echoink-local",
        name: "Vault runtime fixture",
        description: "",
        enabled: false,
        bridgeMode: "prompt-only",
        contentPath: ".echoink/resources/skills/vault-true-fixture/SKILL.md"
      }]
    });
    assert.equal(
      merged.find((resource) => resource.id === resourceId)?.enabled,
      true
    );
    assert.deepEqual(normalized.resources.catalog, []);
  });

  check("stale v47 resource overrides never materialize ghost resources", () => {
    const staleId = "echoink-local:skill:removed-fixture";
    const normalized = normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 47,
      resources: {
        ...structuredClone(DEFAULT_SETTINGS.resources),
        catalog: [],
        enabledByScope: { chat: { [staleId]: true } }
      }
    }).settings;
    const catalog = buildActiveEchoInkResourceCatalog({
      settings: normalized.resources,
      manual: []
    });
    assert.deepEqual(normalized.resources.catalog, []);
    assert.deepEqual(catalog, []);
    assert.deepEqual(enabledSkillResources(catalog), []);
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, "Settings v53 migration contract failed");
  }
}

async function assertJournalDirectorySettingsUi(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createIdentityFixtureState();
  const { plugin } = createIdentityTestPlugin(fixtureState);
  // This legacy-vault scenario reuses its existing English journal folder.
  plugin.app.vault.getAllLoadedFiles = () => [Object.assign(new TFolder(), { path: "journal", name: "journal" })];
  const saved: Array<Record<string, unknown>> = [];
  let nativeOptions: Record<string, unknown> = { folder: "journal", format: "YYYY-MM/YYYY-MM-DD" };
  const daily = { instance: { options: nativeOptions }, loadData: async () => nativeOptions, saveData: async (value: Record<string, unknown>) => { nativeOptions = value; saved.push(structuredClone(value)); } };
  (plugin.app as unknown as { internalPlugins: unknown }).internalPlugins = { plugins: { "daily-notes": daily } };
  plugin.saveSettings = async () => {
    throw new Error("journal folder must persist through native Daily notes");
  };
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  (tab as unknown as { personalMemoryState: Record<string, any> | null })
    .personalMemoryState = structuredClone(fixtureState);
  tab.display();

  const input = tab.containerEl.querySelector<ProviderModalTestElement>(
    'input[aria-label="日记保存文件夹"]'
  );
  assert.ok(input, "general settings expose the journal folder input");
  assert.equal(input.value, "journal");

  input.value = " Notes\\Daily// ";
  input.fireEvent("blur");
  await settleMicrotasks();
  assert.equal(daily.instance.options.folder, "Notes/Daily");
  assert.equal(input.value, "Notes/Daily");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].folder, "Notes/Daily");

  input.value = "../outside";
  input.fireEvent("blur");
  await settleMicrotasks();
  assert.equal(daily.instance.options.folder, "journal");
  assert.equal(input.value, "journal");
  assert.equal(saved.length, 2);
  tab.hide();
  console.log("PASS settings: journal folder normalizes, persists, and reloads");
}

function assertPiReasoningCapabilityContract(): void {
  const efforts = (
    runtimeProviderId: string,
    modelId: string,
    manual = false
  ) => resolveEchoInkPiReasoningCapabilities(
    runtimeProviderId,
    modelId,
    manual
  ).options.map((option) => option.effort);

  const deepSeek = resolveEchoInkPiReasoningCapabilities(
    "deepseek",
    "deepseek-v4-flash"
  );
  assert.deepEqual(deepSeek.options.map((option) => option.effort), [
    "none",
    "high",
    "max"
  ]);
  assert.deepEqual(deepSeek.enabledOptions.map((option) => option.effort), [
    "high",
    "max"
  ]);
  assert.equal(deepSeek.supported, true);
  assert.equal(deepSeek.supportsOff, true);
  assert.equal(deepSeek.defaultEffort, "high");

  for (const providerId of ["qwen-token-plan", "qwen-token-plan-cn"]) {
    const qwen = resolveEchoInkPiReasoningCapabilities(
      providerId,
      "qwen3.8-max-preview"
    );
    assert.deepEqual(qwen.options.map((option) => option.effort), [
      "none",
      "low",
      "medium",
      "xhigh"
    ]);
    assert.deepEqual(qwen.enabledOptions.map((option) => option.effort), [
      "low",
      "medium",
      "xhigh"
    ]);
    assert.equal(qwen.supported, true);
    assert.equal(qwen.supportsOff, true);
    assert.equal(qwen.defaultEffort, "xhigh");
  }

  const qwenGa = resolveEchoInkPiReasoningCapabilities(
    "qwen",
    "qwen3.8-max",
    true
  );
  assert.deepEqual(
    qwenGa.enabledOptions.map((option) => option.effort),
    ["low", "medium", "xhigh"]
  );
  assert.equal(qwenGa.defaultEffort, "xhigh");

  const qwenSingleDefault = resolveEchoInkPiReasoningCapabilities(
    "qwen-token-plan-cn",
    "qwen3.7-plus"
  );
  assert.deepEqual(
    qwenSingleDefault.enabledOptions.map((option) => option.effort),
    ["low", "medium", "high", "xhigh", "max"]
  );

  const glm = resolveEchoInkPiReasoningCapabilities(
    "zai-coding-cn",
    "glm-5.2"
  );
  assert.deepEqual(glm.options.map((option) => option.effort), [
    "none",
    "high",
    "max"
  ]);
  assert.equal(glm.defaultEffort, "high");

  for (const modelId of ["claude-sonnet-4-6", "claude-opus-4-6"]) {
    const claude = resolveEchoInkPiReasoningCapabilities(
      "anthropic",
      modelId
    );
    assert.deepEqual(claude.options.map((option) => option.effort), [
      "none",
      "low",
      "medium",
      "high",
      "max"
    ]);
    assert.equal(claude.defaultEffort, "medium");
  }

  assert.deepEqual(efforts("openai", "gpt-5.6-sol"), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ]);
  assert.deepEqual(efforts("openai-codex", "gpt-5.6-sol"), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ]);
  assert.deepEqual(
    resolveEchoInkPiReasoningCapabilities(
      "openai-codex",
      "gpt-5.6-sol"
    ).enabledOptions.map((option) => option.effort),
    ["low", "medium", "high", "xhigh", "max"]
  );
  assert.deepEqual(efforts("openai", "gpt-4"), []);
  assert.deepEqual(efforts("unknown-runtime", "gpt-5.6-sol"), []);
  const manual = resolveEchoInkPiReasoningCapabilities(
    "unknown-runtime",
    "manual-reasoner",
    true
  );
  assert.deepEqual(manual.options.map((option) => option.effort), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ]);
  assert.deepEqual(manual.enabledOptions.map((option) => option.effort), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ]);
}

function assertKnowledgeMaintenanceSubmitSnapshotContract(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const provider = createApiProviderConfig("deepseek", "maintain-snapshot");
  provider.apiKey = "fixture-key";
  settings.apiProviders = [provider];
  settings.activeApiProviderId = provider.id;
  settings.defaultModel = provider.defaultModelId;
  const model = primaryProviderModel(provider);

  assert.deepEqual(resolveKnowledgeMaintenanceSubmitSnapshot(settings), {
    runtimeProviderId: provider.runtimeProviderId,
    modelId: model.id,
    reasoning: "high"
  });

  model.reasoningEnabled = false;
  assert.deepEqual(resolveKnowledgeMaintenanceSubmitSnapshot(settings), {
    runtimeProviderId: provider.runtimeProviderId,
    modelId: model.id,
    reasoning: "none"
  });

  model.reasoningEnabled = true;
  model.reasoningEffort = "max";
  assert.equal(
    resolveKnowledgeMaintenanceSubmitSnapshot(settings).reasoning,
    "max"
  );

  model.reasoningEffort = "low";
  assert.equal(resolveKnowledgeMaintenanceSubmitSnapshot(settings).reasoning, "high");

  const invalidProvider = createApiProviderConfig(
    "deepseek",
    "maintain-invalid-normalized"
  );
  invalidProvider.apiKey = "fixture-key";
  const invalidModel = primaryProviderModel(
    invalidProvider
  ) as ApiProviderModelConfig & { reasoningEffort: string };
  invalidModel.reasoningEnabled = true;
  invalidModel.reasoningEffort = "turbo";
  const invalidSettings = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    settingsVersion: 53,
    activeApiProviderId: invalidProvider.id,
    defaultModel: invalidProvider.defaultModelId,
    apiProviders: [invalidProvider]
  }).settings;
  const normalizedInvalidModel = invalidSettings.apiProviders[0]?.models[0];
  assert.ok(normalizedInvalidModel);
  assert.equal(normalizedInvalidModel.reasoningEffort, undefined);
  assert.equal(
    apiProviderModelHadInvalidStoredReasoningEffort(
      invalidProvider.id,
      normalizedInvalidModel
    ),
    true
  );
  assert.equal(resolveKnowledgeMaintenanceSubmitSnapshot(invalidSettings).reasoning, "high");

  const nonReasoning = createApiProviderConfig("custom", "maintain-none");
  nonReasoning.runtimeProviderId = "openai";
  nonReasoning.baseUrl = "https://fixture.invalid/v1";
  nonReasoning.apiKey = "fixture-key";
  nonReasoning.models = [createApiProviderModelConfig(
    "custom",
    "gpt-4",
    nonReasoning.runtimeProviderId
  )];
  nonReasoning.defaultModelId = nonReasoning.models[0]?.id ?? "";
  settings.apiProviders = [nonReasoning];
  settings.activeApiProviderId = nonReasoning.id;
  settings.defaultModel = nonReasoning.defaultModelId;
  assert.equal(
    resolveKnowledgeMaintenanceSubmitSnapshot(settings).reasoning,
    "none"
  );
}

async function assertPiReasoningPayloadContract(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("pi_payload_test_network_forbidden");
  };
  try {
    const deepSeek = DEEPSEEK_MODELS["deepseek-v4-flash"];
    assert.ok(deepSeek);
    const deepSeekOff = await capturePiPayload(deepSeek, "off");
    const deepSeekHigh = await capturePiPayload(deepSeek, "high");
    const deepSeekMax = await capturePiPayload(deepSeek, "max");
    assert.deepEqual(deepSeekOff.thinking, { type: "disabled" });
    assert.equal(Object.hasOwn(deepSeekOff, "reasoning_effort"), false);
    assert.deepEqual(deepSeekHigh.thinking, { type: "enabled" });
    assert.equal(deepSeekHigh.reasoning_effort, "high");
    assert.deepEqual(deepSeekMax.thinking, { type: "enabled" });
    assert.equal(deepSeekMax.reasoning_effort, "max");

    const qwen = resolveEchoInkPiCatalogModel(
      "qwen-token-plan",
      "qwen3.8-max-preview"
    );
    assert.ok(qwen);
    const qwenOff = await captureDispatchedPiPayload(qwen, "off");
    assert.equal(qwenOff.enable_thinking, false);
    assert.equal(Object.hasOwn(qwenOff, "reasoning_effort"), false);
    for (const level of ["low", "medium", "xhigh"] as const) {
      const payload = await captureDispatchedPiPayload(qwen, level);
      assert.equal(payload.enable_thinking, true);
      assert.equal(payload.reasoning_effort, level);
      assert.equal(Object.hasOwn(payload, "thinking_budget"), false);
      assert.equal(Object.hasOwn(payload, "thinking"), false);
      assert.equal(Object.hasOwn(payload, "reasoning"), false);
    }

    const qwenGa = createPiNativeModelFromConfiguration({
      catalogModel: undefined,
      provider: {
        providerId: "qwen",
        apiProtocol: "openai-completions",
        authMode: "api-key",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelRef: "qwen3.8-max"
      },
      configured: {
        apiProtocol: "openai-completions",
        contextWindow: 1_000_000,
        maxOutputTokens: 65_536,
        reasoning: true,
        imageInput: true
      }
    });
    for (const level of ["low", "medium", "xhigh"] as const) {
      const payload = await captureDispatchedPiPayload(qwenGa, level);
      assert.equal(payload.enable_thinking, true);
      assert.equal(payload.reasoning_effort, level);
    }

    const custom = createPiNativeModelFromConfiguration({
      catalogModel: undefined,
      provider: {
        providerId: "echoink-custom",
        apiProtocol: "openai-completions",
        authMode: "api-key",
        baseUrl: "https://custom.example/v1",
        modelRef: "manual-reasoner"
      },
      configured: {
        apiProtocol: "openai-completions",
        contextWindow: 64_000,
        maxOutputTokens: 8_192,
        reasoning: true,
        imageInput: false
      }
    });
    for (const level of ["xhigh", "max"] as const) {
      const payload = await captureDispatchedPiPayload(custom, level);
      assert.equal(payload.reasoning_effort, level);
    }

    const gpt = OPENAI_MODELS["gpt-5.6-sol"];
    assert.ok(gpt);
    const openAiEfforts = [
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"]
    ] as const;
    const gptOff = await capturePiPayload(gpt, "off");
    assert.equal(payloadReasoningEffort(gptOff), "none");
    for (const [level, expectedEffort] of openAiEfforts) {
      const payload = await capturePiPayload(gpt, level);
      assert.equal(payloadReasoningEffort(payload), expectedEffort);
    }

    const codexCapabilities = resolveEchoInkPiReasoningCapabilities(
      "openai-codex",
      "gpt-5.6-sol"
    );
    assert.equal(
      codexCapabilities.options.some((option) => option.effort === "minimal"),
      false
    );
    assert.equal(
      new Set(codexCapabilities.options.map((option) => option.wireValueKey)).size,
      codexCapabilities.options.length
    );

    const codex = OPENAI_CODEX_MODELS["gpt-5.6-sol"];
    assert.ok(codex);
    const codexOff = await capturePiPayload(codex, "off");
    assert.equal(Object.hasOwn(codexOff, "reasoning"), false);
    for (const [level, expectedEffort] of [
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"]
    ] as const) {
      assert.equal(
        payloadReasoningEffort(await capturePiPayload(codex, level)),
        expectedEffort
      );
    }

    const glm = ZAI_CODING_CN_MODELS["glm-5.2"];
    assert.ok(glm);
    const glmOff = await capturePiPayload(glm, "off");
    assert.deepEqual(glmOff.thinking, { type: "disabled" });
    assert.equal(Object.hasOwn(glmOff, "reasoning_effort"), false);
    for (const level of ["low", "medium", "high"] as const) {
      const payload = await capturePiPayload(glm, level);
      assert.deepEqual(payload.thinking, {
        type: "enabled",
        clear_thinking: false
      });
      assert.equal(payload.reasoning_effort, "high");
    }
    const glmMax = await capturePiPayload(glm, "max");
    assert.equal(glmMax.reasoning_effort, "max");

    for (const modelId of [
      "claude-sonnet-4-6",
      "claude-opus-4-6"
    ] as const) {
      const claude = ANTHROPIC_MODELS[modelId];
      assert.ok(claude);
      const off = await capturePiPayload(claude, "off");
      assert.deepEqual(off.thinking, { type: "disabled" });
      assert.equal(Object.hasOwn(off, "output_config"), false);
      for (const [level, expectedEffort] of [
        ["minimal", "low"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["max", "max"]
      ] as const) {
        const payload = await capturePiPayload(claude, level);
        assert.deepEqual(payload.thinking, {
          type: "adaptive",
          display: "summarized"
        });
        assert.deepEqual(payload.output_config, { effort: expectedEffort });
      }
    }
    assert.equal(networkAttempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function capturePiPayload(
  model: Model<Api>,
  reasoning: ModelThinkingLevel
): Promise<Record<string, unknown>> {
  const context: Context = {
    messages: [{
      role: "user",
      content: "EchoInk payload fixture",
      timestamp: 1
    }]
  };
  let payload: unknown;
  const options: StreamOptions = {
    apiKey: model.api === "openai-codex-responses"
      ? fixtureOpenAICodexJwt()
      : "fixture-not-a-real-key",
    ...(reasoning === "off" ? {} : { reasoning }),
    onPayload(value) {
      payload = structuredClone(value);
      throw new Error("echoink_payload_captured_before_network");
    }
  };
  const stream = streamSimple(model, context, options);
  await stream.result();
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
  return payload as Record<string, unknown>;
}

async function captureDispatchedPiPayload(
  model: Model<Api>,
  reasoning: ModelThinkingLevel
): Promise<Record<string, unknown>> {
  let payload: unknown;
  const stream = new PiProviderProtocolDispatcher().streamSimple({
    model,
    context: {
      messages: [{
        role: "user",
        content: "EchoInk final payload fixture",
        timestamp: 1
      }]
    },
    apiKey: "fixture-not-a-real-key",
    options: {
      reasoning,
      onPayload(value) {
        payload = structuredClone(value);
        throw new Error("echoink_payload_captured_before_network");
      }
    }
  });
  await stream.result();
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
  return payload as Record<string, unknown>;
}

function payloadReasoningEffort(payload: Record<string, unknown>): unknown {
  const reasoning = payload.reasoning;
  assert.ok(reasoning && typeof reasoning === "object");
  return (reasoning as Record<string, unknown>).effort;
}

function fixtureOpenAICodexJwt(): string {
  const encode = (value: unknown) => Buffer.from(
    JSON.stringify(value),
    "utf8"
  ).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "fixture-account"
    }
  })}.fixture-signature`;
}

function assertOnboardingTruthContract(): void {
  assert.equal(isEmptyEchoInkPluginData(undefined), true);
  assert.equal(isEmptyEchoInkPluginData(null), true);
  assert.equal(isEmptyEchoInkPluginData({}), true);
  assert.equal(isEmptyEchoInkPluginData({ settingsVersion: 49 }), false);

  const settings = structuredClone(DEFAULT_SETTINGS);
  assert.equal(settings.setup.tutorialStep, "sidebar");
  assert.equal(settings.setup.tutorialVersion, "");
  assert.equal(shouldAutoStartEchoInkOnboarding(true, settings.setup), true);
  assert.equal(
    shouldAutoStartEchoInkOnboarding(false, settings.setup),
    true,
    "an unfinished tutorial starts without depending on configuration truth"
  );
  assert.equal(prepareEchoInkOnboardingTutorial(settings.setup, { forceRestart: false }), true);
  assert.equal(settings.setup.tutorialVersion, ECHOINK_ONBOARDING_VERSION);
  assert.equal(settings.setup.tutorialStep, "sidebar");

  settings.setup.dismissedVersion = ECHOINK_ONBOARDING_VERSION;
  assert.equal(
    shouldAutoStartEchoInkOnboarding(false, settings.setup, false),
    false,
    "ordinary Obsidian startup must not repeat a seen tutorial"
  );
  assert.equal(
    shouldAutoStartEchoInkOnboarding(false, settings.setup, true),
    false,
    "enabling the plugin after layout-ready preserves an explicit skip"
  );
  settings.setup.tutorialStep = "knowledge";
  assert.equal(prepareEchoInkOnboardingTutorial(settings.setup, { forceRestart: true }), true);
  assert.equal(settings.setup.tutorialStep, "sidebar");
  settings.setup.dismissedVersion = "";

  let truth = deriveEchoInkOnboardingTruth(settings, null);
  assert.equal(truth.providerComplete, false);
  assert.equal(truth.knowledgeComplete, false);
  assert.equal(truth.personalityComplete, false);

  const provider = createApiProviderConfig("deepseek", "onboarding-provider");
  provider.apiKey = "configured-key";
  settings.apiProviders = [provider];
  settings.activeApiProviderId = provider.id;
  settings.knowledgeBase.initialization.status = "initialized";
  truth = deriveEchoInkOnboardingTruth(settings, "template-balanced");
  assert.deepEqual(truth, {
    providerComplete: true,
    knowledgeComplete: true,
    personalityComplete: true
  });
  assert.equal(settings.setup.tutorialStep, "sidebar");

  const first = advanceEchoInkOnboardingTutorial(settings.setup, "sidebar", 101);
  assert.deepEqual(first, { changed: true, completed: false, nextStep: "provider" });
  assert.equal(settings.setup.completedAt, 0);
  const stale = advanceEchoInkOnboardingTutorial(settings.setup, "sidebar", 102);
  assert.deepEqual(stale, { changed: false, completed: false, nextStep: "provider" });
  assert.deepEqual(
    advanceEchoInkOnboardingTutorial(settings.setup, "provider", 104),
    { changed: true, completed: false, nextStep: "knowledge" }
  );
  assert.deepEqual(
    advanceEchoInkOnboardingTutorial(settings.setup, "knowledge", 105),
    { changed: true, completed: false, nextStep: "personality" }
  );
  assert.deepEqual(
    advanceEchoInkOnboardingTutorial(settings.setup, "personality", 106),
    { changed: true, completed: false, nextStep: "colleague" }
  );
  const finish = advanceEchoInkOnboardingTutorial(settings.setup, "colleague", 107);
  assert.deepEqual(finish, { changed: true, completed: true, nextStep: null });
  assert.equal(settings.setup.completedAt, 107);
  assert.equal(settings.setup.lastCheckedAt, 107);
  assert.equal(settings.setup.dismissedVersion, ECHOINK_ONBOARDING_VERSION);
  assert.equal(shouldAutoStartEchoInkOnboarding(false, settings.setup), false);
  assert.equal(settings.setup.tutorialStep, "sidebar");

  assert.equal(echoInkOnboardingTab("provider"), "providers");
  assert.equal(echoInkOnboardingTab("knowledge"), "knowledgeBase");
  assert.equal(echoInkOnboardingTab("personality"), "general");

  const resumed = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    setup: {
      completedAt: 0,
      lastCheckedAt: 0,
      dismissedVersion: ECHOINK_ONBOARDING_VERSION,
      tutorialVersion: ECHOINK_ONBOARDING_VERSION,
      tutorialStep: "knowledge"
    }
  }).settings;
  assert.equal(resumed.setup.tutorialStep, "knowledge");
  assert.equal(resumed.setup.dismissedVersion, ECHOINK_ONBOARDING_VERSION);
  assert.equal(shouldAutoStartEchoInkOnboarding(true, resumed.setup), false);
  dismissEchoInkOnboardingTutorial(resumed.setup);
  assert.equal(resumed.setup.tutorialStep, "knowledge");
  assert.equal(
    shouldAutoStartEchoInkOnboarding(false, resumed.setup),
    false,
    "a seen tutorial stays closed during an ordinary restart"
  );
  assert.equal(normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    setup: { tutorialStep: "invalid" }
  }).settings.setup.tutorialStep, "sidebar");
  assert.equal(settings.memory.dreamEnabled, true);
}

function assertFiveStepOnboardingEntrypoints(): void {
  installProviderModalDomFixture();
  const expected = [
    ["sidebar", "认识 EchoInk · 01 / 05", "认识工作台和你的 Agent"],
    ["provider", "认识 EchoInk · 02 / 05", "连接一个模型"],
    ["knowledge", "认识 EchoInk · 03 / 05", "给知识库安个家"],
    ["personality", "认识 EchoInk · 04 / 05", "认识总助"],
    ["colleague", "认识 EchoInk · 05 / 05", "再请一位同事"]
  ] as const;
  for (const [step, stepLabel, title] of expected) {
    const copy = onboardingCoachmarkCopy(step, true);
    assert.equal(copy.step, stepLabel);
    assert.equal(copy.title, title);
    assert.doesNotMatch(copy.description, /本教程|配置完整|可恢复的预览|Memory 学习|稍后/u);
  }
  assert.equal(onboardingCoachmarkCopy("sidebar", true).action, "下一步");
  assert.equal(onboardingCoachmarkCopy("settings", true).step, "认识 EchoInk · 01 / 05");
  assert.equal(onboardingCoachmarkCopy("provider", true).action, "下一步");
  assert.equal(onboardingCoachmarkCopy("knowledge", true).action, "下一步");
  assert.equal(onboardingCoachmarkCopy("personality", true).action, "下一步");
  assert.equal(onboardingCoachmarkCopy("colleague", true).action, "创建并完成", "the guide delegates creation to the current editor");
  assert.equal(onboardingCoachmarkCopy("colleague", false).action, "Create and finish");
  assert.deepEqual(expected.map(([step]) => onboardingCoachmarkCopy(step, true).tone), Array(5).fill("purple"));

  const root = providerModalTestDocument.createElement("div");
  let settingsCalls = 0;
  renderCodexHeader(root as never, {
    onOpenWorkspaceResources: () => undefined,
    onOpenSettings: () => { settingsCalls += 1; }
  });
  const settingsButton = root.querySelector<ProviderModalTestElement>(".codex-settings-button");
  assert.ok(settingsButton);
  assert.equal(settingsButton!.getAttribute("data-echoink-onboarding-anchor"), "settings");
  settingsButton!.click();
  assert.equal(settingsCalls, 1);

  // Actual resume routes and workspace actions are exercised below; source
  // spellings are not evidence that a guide opens the intended product page.
  console.log("PASS settings: five visible onboarding steps and the existing settings entry");
}

function assertCodexHeaderIdentityContract(): void {
  installProviderModalDomFixture();
  const root = providerModalTestDocument.createElement("div");
  const avatarUrl = "data:image/webp;base64,UkVE";
  renderCodexHeader(root as never, {
    onOpenWorkspaceResources: () => undefined,
    onOpenSettings: () => undefined
  }, {
    displayName: "小墨",
    avatarUrl
  });

  const label = root.querySelector<ProviderModalTestElement>(".codex-title-text");
  const icon = root.querySelector<ProviderModalTestElement>(".codex-title-icon-codex");
  const avatar = root.querySelector<ProviderModalTestElement>(".codex-title-avatar");
  assert.equal(label?.textContent, "小墨");
  assert.equal(avatar?.getAttribute("src"), avatarUrl);
  assert.equal(icon?.hasClass("has-image"), true);

  updateCodexHeaderIdentity(root as never, { displayName: "   ", avatarUrl: null });
  assert.equal(label?.textContent, "EchoInk");
  assert.equal(root.querySelector(".codex-title-avatar"), null);
  assert.equal(icon?.hasClass("has-image"), false);

  updateCodexHeaderIdentity(root as never, { displayName: "新名字", avatarUrl });
  assert.equal(label?.textContent, "新名字");
  assert.equal(
    root.querySelector<ProviderModalTestElement>(".codex-title-avatar")?.getAttribute("src"),
    avatarUrl
  );

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.codex-title-avatar\s*\{[^}]*object-fit:\s*cover/u);
  console.log("PASS settings: sidebar header follows cached Agent identity");
}

async function assertOnboardingCoachmarkAccessibilityContract(): Promise<void> {
  installProviderModalDomFixture();
  // The guide's Escape guard queries the owning document for an upper layer.
  const quotedSelector = (selector: string) => selector.replace(/\[([\w-]+)=([\w-]+)\]/gu, '[$1="$2"]');
  const queryLayers = (selector: string) => providerModalTestDocument.body.querySelectorAll(quotedSelector(selector)).map(element => Object.assign(element, {
    getClientRects: () => {
      for (let node: ProviderModalTestElement | null = element; node; node = node.parentElement) {
        if (node.getAttribute("hidden") !== null || node.style.getPropertyValue("display") === "none") return [];
      }
      return element.isConnected ? [element.getBoundingClientRect()] : [];
    }
  }));
  const computedStyle = (element: ProviderModalTestElement) => ({ visibility: element.style.getPropertyValue("visibility") || "visible", getPropertyValue: (name: string) => element.style.getPropertyValue(name) });
  Object.assign(providerModalTestDocument, { querySelector: (selector: string) => queryLayers(selector)[0] ?? null, querySelectorAll: queryLayers });
  Object.assign(providerModalTestDocument.defaultView, { getComputedStyle: computedStyle });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  let dismissCalls = 0;
  let now = 200;
  const advanceCalls: string[] = [];
  const plugin = withSettingsTabDefaults({
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    dismissEchoInkOnboarding: async () => { dismissCalls += 1; },
    openPendingEchoInkOnboarding: async () => undefined,
    runEchoInkOnboardingNavigation(this: unknown, action: () => Promise<void>): Promise<void> {
      return CodexForObsidianPlugin.prototype.runEchoInkOnboardingNavigation.call(this as CodexForObsidianPlugin, action);
    },
    advanceEchoInkOnboarding: async (
      step: "sidebar" | "settings" | "provider" | "knowledge" | "personality" | "colleague"
    ) => {
      advanceCalls.push(step);
      return advanceEchoInkOnboardingTutorial(settings.setup, step, ++now).nextStep;
    }
  });
  const tab = new CodexSettingTab(plugin as never);
  const mutable = tab as unknown as {
    renderOnboardingCoachmark(
      step: "sidebar" | "settings" | "provider" | "knowledge" | "personality" | "colleague"
    ): void;
    clearOnboardingCoachmark(restoreFocus: boolean): void;
    showOnboardingCompletion(): void;
  };
  const restoreFocus = providerModalTestDocument.createElement("button");
  providerModalTestDocument.body.appendChild(restoreFocus);

  for (const fixture of [
    { step: "provider" as const, key: "providers:add", label: "连接一个模型", action: "下一步" },
    { step: "knowledge" as const, key: "knowledge:onboarding", label: "给知识库安个家", action: "下一步" },
    { step: "personality" as const, key: "general:personality-template", label: "认识总助", action: "下一步" }
  ]) {
    tab.containerEl.empty();
    const anchor = tab.containerEl.createEl("button", {
      cls: fixture.step === "personality" ? "echoink-agent-editor-header" : "",
      attr: { "data-echoink-focus-key": fixture.key }
    });
    restoreFocus.focus();
    mutable.renderOnboardingCoachmark(fixture.step);
    const coachmark = providerModalTestDocument.body.querySelector(
      `.echoink-onboarding-coachmark.is-${fixture.step}`
    );
    assert.ok(coachmark);
    assert.equal(coachmark.getAttribute("role"), "dialog");
    assert.equal(coachmark.getAttribute("aria-modal"), "false");
    assert.equal(coachmark.getAttribute("aria-label"), fixture.label);
    assert.equal(coachmark.getAttribute("tabindex"), "-1");
    assert.equal(
      coachmark.querySelector("button.echoink-onboarding-action")?.textContent,
      fixture.action
    );
    assert.equal(coachmark.querySelectorAll("button").length, 8);
    assert.equal(coachmark.querySelectorAll('[aria-current="step"]').length, 1);
    const action = coachmark.querySelector("button.echoink-onboarding-action");
    assert.equal(action?.getAttribute("aria-label"), fixture.action);
    assert.equal(
      action?.querySelector(".echoink-onboarding-action-icon")?.getAttribute("data-echoink-icon"),
      "arrow-right"
    );
    assert.equal(action?.querySelectorAll(".echoink-onboarding-action-icon").length, 1);
    assert.equal(
      action?.querySelector(".echoink-onboarding-action-label")?.textContent,
      fixture.action
    );
    assert.equal(providerModalTestDocument.activeElement, action);
    assert.equal(anchor.hasClass("is-echoink-onboarding-target"), true);
    assert.equal(anchor.scrollIntoViewCalls, 3);
    mutable.clearOnboardingCoachmark(true);
    assert.equal(providerModalTestDocument.activeElement, anchor);
    assert.equal(anchor.hasClass("is-echoink-onboarding-target"), false);
  }

  const detachedDocument = new ProviderModalTestDocument();
  const detachedTab = new CodexSettingTab(plugin as never);
  const detachedContainer = detachedDocument.createElement("div");
  detachedDocument.body.appendChild(detachedContainer);
  (detachedTab as unknown as { containerEl: ProviderModalTestElement }).containerEl =
    detachedContainer;
  const detachedAnchor = detachedContainer.createEl("button", {
    attr: { "data-echoink-focus-key": "providers:add" }
  });
  const detachedMutable = detachedTab as unknown as {
    renderOnboardingCoachmark(
      step: "sidebar" | "settings" | "provider" | "knowledge" | "personality" | "colleague"
    ): void;
    clearOnboardingCoachmark(restoreFocus: boolean): void;
  };
  detachedMutable.renderOnboardingCoachmark("provider");
  const detachedCoachmark = detachedDocument.body.querySelector(
    ".echoink-onboarding-coachmark.is-provider"
  );
  assert.ok(detachedCoachmark, "coachmark must render in the settings window document");
  assert.equal(detachedCoachmark.ownerDocument, detachedDocument);
  assert.equal(detachedAnchor.hasClass("is-echoink-onboarding-target"), true);
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark"),
    null,
    "detached settings coachmark must not leak into the main Vault document"
  );
  detachedMutable.clearOnboardingCoachmark(false);

  settings.setup.completedAt = 0;
  settings.setup.tutorialStep = "provider";
  settings.setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
  for (const fixture of [
    { step: "provider" as const, key: "providers:add", tab: "providers" as const, nextStep: "knowledge" },
    { step: "knowledge" as const, key: "knowledge:onboarding", tab: "knowledgeBase" as const, nextStep: "personality" },
    { step: "personality" as const, key: "general:personality-template", tab: "general" as const, nextStep: "colleague" }
  ]) {
    settings.settingsTab = fixture.tab;
    tab.containerEl.empty();
    tab.containerEl.createEl("button", {
      cls: fixture.step === "personality" ? "echoink-agent-editor-header" : "",
      attr: { "data-echoink-focus-key": fixture.key }
    });
    mutable.renderOnboardingCoachmark(fixture.step);
    const next = providerModalTestDocument.body
      .querySelector<ProviderModalTestElement>(".echoink-onboarding-coachmark")
      ?.querySelector<ProviderModalTestElement>("button.echoink-onboarding-action");
    assert.ok(next);
    next.click();
    await flushProviderModalTasks();
    assert.equal(settings.setup.tutorialStep, fixture.nextStep);
  }
  assert.deepEqual(advanceCalls, ["provider", "knowledge", "personality"]);
  assert.equal(settings.setup.completedAt, 0, "the first four steps cannot complete before the colleague is saved");
  assert.equal(settings.setup.tutorialStep, "colleague");
  assert.equal(providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark.is-complete"), null);
  mutable.showOnboardingCompletion();
  const completion = providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark.is-complete");
  assert.ok(completion);
  assert.equal(completion.querySelectorAll("button").length, 2);
  assert.equal(providerModalTestDocument.body.querySelector(".echoink-onboarding-spotlight"), null);
  mutable.clearOnboardingCoachmark(false);

  tab.containerEl.empty();
  const escapeAnchor = tab.containerEl.createEl("button", {
    attr: { "data-echoink-focus-key": "providers:add" }
  });
  restoreFocus.focus();
  mutable.renderOnboardingCoachmark("provider");
  providerModalTestDocument.fireEvent("keydown", { key: "Escape" });
  await flushProviderModalTasks();
  assert.equal(dismissCalls, 1);
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark"),
    null
  );
  assert.equal(providerModalTestDocument.activeElement, escapeAnchor);

  // The shared mount also supports a simple caller without optional navigation.
  // Production callers above supply the persistent dismissal callback.
  const mandatoryAnchor = providerModalTestDocument.createElement("button");
  providerModalTestDocument.body.appendChild(mandatoryAnchor);
  let mandatoryActionCalls = 0;
  mountEchoInkOnboardingCoachmark({
    anchor: mandatoryAnchor as never,
    stepClass: "sidebar",
    stepLabel: "第 1 步，共 5 步",
    title: "打开 Agent 侧栏",
    description: "点击左侧机器人图标。",
    actionLabel: "打开 EchoInk",
    onAction: () => { mandatoryActionCalls += 1; }
  });
  let mandatoryCoachmark = providerModalTestDocument.body.querySelector(
    ".echoink-onboarding-coachmark.is-sidebar"
  );
  assert.ok(mandatoryCoachmark);
  assert.deepEqual(
    Array.from(mandatoryCoachmark.querySelectorAll("button")).map((button) => button.textContent),
    ["打开 EchoInk"]
  );
  providerModalTestDocument.fireEvent("keydown", { key: "Escape" });
  await flushProviderModalTasks();
  assert.equal(mandatoryActionCalls, 0);
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark.is-sidebar"),
    null
  );

  const mandatoryHandle = mountEchoInkOnboardingCoachmark({
    anchor: mandatoryAnchor as never,
    stepClass: "sidebar",
    stepLabel: "第 1 步，共 5 步",
    title: "打开 Agent 侧栏",
    description: "点击左侧机器人图标。",
    actionLabel: "打开 EchoInk",
    onAction: () => { mandatoryActionCalls += 1; }
  });
  mandatoryCoachmark = providerModalTestDocument.body.querySelector(
    ".echoink-onboarding-coachmark.is-sidebar"
  );
  mandatoryCoachmark?.querySelector<ProviderModalTestElement>("button.echoink-onboarding-action")?.click();
  await flushProviderModalTasks();
  assert.equal(mandatoryActionCalls, 1);
  mandatoryHandle.destroy();

  await assertOnboardingVisibleLayerEscape();

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.echoink-onboarding-coachmark\s*\{[\s\S]*?animation:\s*none/u);
  assert.doesNotMatch(css, /\.echoink-onboarding-coachmark \.echoink-onboarding-action\s*\{\s*width:\s*100%;/u);

}

async function assertOnboardingVisibleLayerEscape(): Promise<void> {
  const anchor = providerModalTestDocument.body.createEl("button");
  for (const step of ["sidebar", "colleague"] as const) {
    for (const [role, display, visibility] of [["listbox", "none", "visible"], ["menu", "block", "hidden"]] as const) {
      const layer = providerModalTestDocument.body.createDiv({ attr: { role } });
      layer.style.setProperty("display", display); layer.style.setProperty("visibility", visibility);
      let dismisses = 0, prevented = 0;
      const guide = mountEchoInkOnboardingCoachmark({ anchor: anchor as never, stepClass: step, stepLabel: step, title: "Guide", description: "Fixture", dismissLabel: "Skip guide", onDismiss: () => { dismisses++; } });
      providerModalTestDocument.fireEvent("keydown", { key: "Escape", preventDefault: () => { prevented++; } });
      await flushProviderModalTasks();
      assert.equal(dismisses, 1, `${step}: hidden ${role} must not block Escape`);
      assert.equal(guide.element.isConnected, false); assert.equal(prevented, 1);
      layer.remove(); guide.destroy();
    }
    for (const role of ["listbox", "menu"] as const) {
      const layer = providerModalTestDocument.body.createDiv({ attr: { role } });
      let dismisses = 0, prevented = 0;
      const guide = mountEchoInkOnboardingCoachmark({ anchor: anchor as never, stepClass: step, stepLabel: step, title: "Guide", description: "Fixture", dismissLabel: "Skip guide", onDismiss: () => { dismisses++; } });
      providerModalTestDocument.fireEvent("keydown", { key: "Escape", preventDefault: () => { prevented++; } });
      await flushProviderModalTasks();
      assert.equal(dismisses, 0, `${step}: visible ${role} handles Escape before the guide`);
      assert.equal(guide.element.isConnected, true); assert.equal(prevented, 0, "the guide must not consume the upper layer's Escape");
      layer.remove();
      providerModalTestDocument.fireEvent("keydown", { key: "Escape" }); await flushProviderModalTasks();
      assert.equal(dismisses, 1); assert.equal(guide.element.isConnected, false); guide.destroy();
    }
  }
  anchor.remove();
  console.log("PASS onboarding Escape: hidden composer layers ignored; visible menus/listboxes retain first handling in steps 1 and 5");
}

async function assertSettingsDeleteFailuresKeepAuthoritativeRows(): Promise<void> {
  installProviderModalDomFixture();
  const previousDesktop = Platform.isDesktopApp;
  Platform.isDesktopApp = true;
  try {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.settingsTab = "providers";
    settings.settingsLanguage = "en";
    const provider = createApiProviderConfig("deepseek", "delete-rejected-active");
    provider.apiKey = "synthetic-delete-key";
    const fallback = createApiProviderConfig("ollama", "delete-rejected-fallback");
    settings.apiProviders = [provider, fallback];
    activateApiProvider(settings, provider);
    const resource = { ...mcpResourceFixture("delete-rejected-mcp", true), bridgeMode: "native-mcp" as const };
    settings.resources.catalog = [resource];
    settings.resources.mcpConnections[resource.id] = { transport: "http", url: "https://mcp-fixture.invalid", trusted: false, tools: [], toolPolicies: {} };
    let providerAttempts = 0;
    let mcpAttempts = 0;
    let saves = 0;
    const plugin = withSettingsTabDefaults({ app: new App(), manifest: { id: "echoink-delete-rejection" }, settings,
      saveSettings: async () => { saves++; },
      activateApiProviderSettings: async (mutate: (candidate: typeof settings) => void, mode: string) => {
        providerAttempts++;
        const candidate = structuredClone(settings);
        mutate(candidate);
        assert.deepEqual(candidate.apiProviders.map(item => item.id), [fallback.id]);
        assert.equal(candidate.activeApiProviderId, fallback.id);
        assert.equal(mode, "replace");
        throw new Error("synthetic Provider activation rejected");
      },
      deleteEchoInkMcpServer: async (id: string) => {
        mcpAttempts++;
        assert.equal(id, resource.id);
        throw new Error("synthetic MCP delete rejected");
      }
    });
    const tab = new CodexSettingTab(plugin as never);
    const mutable = tab as any;
    try {
      tab.display();
      const providerSnapshot = JSON.stringify({ providers: settings.apiProviders, active: settings.activeApiProviderId, model: settings.defaultModel });
      const providerSelector = `[data-echoink-focus-key="provider:${provider.id}:edit"]`;
      const providerRow = tab.containerEl.querySelector(providerSelector)?.closest(".codex-provider-saved-row");
      assert.ok(providerRow);
      const noticesBefore = openTestNoticeMessages.length;
      await mutable.deleteSavedProviderModel(provider.id);
      assert.equal(providerAttempts, 1);
      assert.equal(JSON.stringify({ providers: settings.apiProviders, active: settings.activeApiProviderId, model: settings.defaultModel }), providerSnapshot,
        "rejected activation preserves the deleted connection, active model and fallback configuration");
      assert.equal(tab.containerEl.querySelector(providerSelector)?.closest(".codex-provider-saved-row"), providerRow,
        "a failed delete leaves the original saved-model row mounted");
      assert.ok(openTestNoticeMessages.slice(noticesBefore).includes("synthetic Provider activation rejected"));
      mutable.renderSettingsContent();
      assert.ok(tab.containerEl.querySelector(providerSelector), "the authoritative row survives a later redraw");
      assert.equal(saves, 0);

      mutable.resourceLoaded.mcp = true;
      mutable.resourceSnapshot = emptyWorkspaceResourceSnapshot();
      let reloads = 0;
      mutable.loadWorkspaceResources = async () => { reloads++; };
      resetSynchronousSettingsDisplayFrame(tab);
      tab.openDesktopRoute({ tab: "capabilities", capabilityTab: "mcp" });
      mutable.renderSettingsContent();
      const resourceSelector = `[data-resource-key="${resource.id}"]`;
      assert.ok(tab.containerEl.querySelector(resourceSelector));
      const resourceSnapshot = JSON.stringify(settings.resources);
      mutable.settingsDetail = { kind: "resource", resourceId: resource.id };
      mutable.renderSettingsContent();
      const remove = tab.containerEl.querySelector<ProviderModalTestElement>(`[data-echoink-focus-key="resource:${resource.id}:delete"]`);
      assert.ok(remove);
      await mutable.deleteMcpServer(resource, remove);
      assert.equal(mcpAttempts, 1);
      assert.equal(reloads, 0, "a rejected delete must not refresh away the still-authoritative MCP row");
      assert.equal(JSON.stringify(settings.resources), resourceSnapshot, "failed MCP deletion preserves the catalog and connection fields");
      assert.deepEqual(mutable.settingsDetail, { kind: "resource", resourceId: resource.id });
      assert.equal(remove.disabled, false, "delete can be retried from the same detail");
      assert.ok(openTestNoticeMessages.includes("The MCP server was not deleted."));
      resetSynchronousSettingsDisplayFrame(tab);
      await mutable.closeSettingsDetail();
      mutable.renderSettingsContent();
      assert.ok(tab.containerEl.querySelector(resourceSelector), "returning to the list still shows the failed MCP deletion");
      assert.equal(reloads, 0);
      assert.equal(saves, 0);
    } finally { tab.hide(); }
  } finally { Platform.isDesktopApp = previousDesktop; }
  console.log("PASS P11 delete failures: actual settings Provider/MCP methods keep configuration, current model, rows and retry; no false refresh/save");
}

async function assertDesktopDemoResourceGroupsPreserveSearch(): Promise<void> {
  installProviderModalDomFixture();
  const previousDesktop = Platform.isDesktopApp; Platform.isDesktopApp = true;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "providers";
  const provider = createApiProviderConfig("deepseek", "align-provider"); provider.apiKey = "synthetic-key";
  settings.apiProviders = [provider]; activateApiProvider(settings, provider);
  const custom = { id: "echoink-local:skill:align-custom", kind: "skill" as const, source: "echoink-local" as const,
    name: "CUSTOM-SEARCH", description: "用户自建原文", enabled: false, bridgeMode: "prompt-only" as const };
  const builtin = { ...custom, id: "echoink-local:skill:daily-journal", name: "内置日记", metadata: { resourceId: "daily-journal", userModified: true, fileStatus: "missing" } };
  const server = { ...mcpResourceFixture("align-mcp", true), bridgeMode: "native-mcp" as const };
  settings.resources.catalog = [custom, builtin, server];
  settings.resources.mcpConnections[server.id] = { transport: "http", url: "https://mcp-fixture.invalid", trusted: false, tools: [], toolPolicies: {} };
  let saves = 0;
  const plugin = withSettingsTabDefaults({ app: new App(), manifest: { id: "align-fixture" }, settings, saveSettings: async () => { saves++; } });
  const tab = new CodexSettingTab(plugin as never), mutable = tab as any;
  mutable.runtimeEchoInkResources = [custom, builtin, server];
  try {
    tab.display();
    assert.ok(tab.containerEl.querySelector(".echoink-settings-aligned"));
    assert.equal(tab.containerEl.querySelectorAll("button[data-settings-tab]").length, 6);
    assert.ok(tab.containerEl.querySelector('[data-echoink-focus-key="providers:add"]'));
    assert.equal(tab.containerEl.querySelector('[data-echoink-focus-key="provider:align-provider:delete"]'), null, "desktop model deletion is available only in details");
    const originalOnOpen = ProviderModelModal.prototype.onOpen;
    let openedDetached = false, inheritedPresentation = false;
    try {
      ProviderModelModal.prototype.onOpen = function() {
        // This legacy DOM fixture defaults isConnected to true; actual shell
        // ancestry still distinguishes the production detached mount phase.
        openedDetached = !tab.containerEl.contains(this.modalEl);
        inheritedPresentation = this.modalEl.closest(".echoink-settings-aligned") !== null;
        originalOnOpen.call(this);
      };
      mutable.openProviderModelModal(provider, true);
    } finally { ProviderModelModal.prototype.onOpen = originalOnOpen; }
    assert.equal(openedDetached, true, "the production editor still opens before its host is attached to the settings shell");
    assert.equal(inheritedPresentation, true, "the production detached host passes desktop presentation before onOpen");
    assert.ok(tab.containerEl.querySelector(".echoink-provider-form-brand"), "the first real editor render uses its configured presentation");
    assert.equal(tab.containerEl.querySelectorAll(".provider-form-section").length, 2);
    mutable.resourceSnapshot = emptyWorkspaceResourceSnapshot(); mutable.resourceLoaded.skills = true; mutable.resourceLoaded.mcp = true;
    resetSynchronousSettingsDisplayFrame(tab); tab.openDesktopRoute({ tab: "capabilities", capabilityTab: "skills" }); mutable.renderSettingsContent();
    const customRow = tab.containerEl.querySelector<ProviderModalTestElement>(`[data-resource-key="${custom.id}"]`)!;
    const builtinRow = tab.containerEl.querySelector<ProviderModalTestElement>(`[data-resource-key="${builtin.id}"]`)!;
    assert.ok(customRow); assert.ok(builtinRow);
    assert.equal(customRow.closest('[data-resource-group="custom"]')?.getAttribute("data-resource-group"), "custom");
    assert.equal(builtinRow.closest('[data-resource-group="builtin"]')?.getAttribute("data-resource-group"), "builtin");
    assert.equal(builtinRow.querySelector("[data-resource-preset]"), null, "the desktop built-in group does not repeat a static preset badge");
    assert.ok(builtinRow.querySelector('[data-resource-skill-state="customized"]'));
    assert.ok(builtinRow.querySelector('[data-resource-skill-state="missing"]'), "real customization and file errors stay visible");
    const detail = customRow.querySelector(`[data-echoink-focus-key="resource:${custom.id}:detail"]`)!;
    assert.match(detail.textContent, /CUSTOM-SEARCH.*用户自建原文/u, "the left navigation control includes the description");
    assert.equal(customRow.querySelector(".codex-resource-row-desc")!.textContent, "用户自建原文", "desktop descriptions retain source text without appending UI provenance");
    assert.equal(detail.querySelector('[role="switch"]'), null, "the resource toggle remains an independent control");
    mutable.resourceSearchQuery.skills = "CUSTOM-SEARCH"; mutable.applyResourceSearchFilter("skills");
    assert.equal(customRow.hasClass("is-search-hidden"), false); assert.equal(builtinRow.hasClass("is-search-hidden"), true);
    mutable.resourceSearchQuery.skills = ""; mutable.applyResourceSearchFilter("skills"); assert.equal(builtinRow.hasClass("is-search-hidden"), false);
    resetSynchronousSettingsDisplayFrame(tab); tab.openDesktopRoute({ tab: "capabilities", capabilityTab: "mcp" }); mutable.renderSettingsContent();
    const mcpAdd = tab.containerEl.querySelector('[data-echoink-focus-key="resources:mcp:add"]');
    assert.ok(mcpAdd); assert.ok(mcpAdd.closest(".codex-resource-list-header"));
    const mcpRow = tab.containerEl.querySelector(`[data-resource-key="${server.id}"]`)!;
    assert.ok(mcpRow.querySelector(".codex-resource-connection-state"));
    assert.doesNotMatch(mcpRow.querySelector(".codex-resource-connection-state")!.textContent, /已连接|Connection verified/iu, "a configured endpoint is not a verified connection");
    assert.equal(saves, 0, "opening, searching and switching presentation do not persist settings");
  } finally { tab.hide(); Platform.isDesktopApp = previousDesktop; }
  console.log("PASS aligned desktop shell/resource groups: six search rows, retained actions, independent controls, filtering, real MCP status and zero navigation writes");
}

async function assertDesktopModelAndMcpFinish(): Promise<void> {
  installProviderModalDomFixture();
  const previousDesktop = Platform.isDesktopApp;
  Platform.isDesktopApp = true;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "providers";
  settings.settingsLanguage = "en";
  const provider = createApiProviderConfig("deepseek", "finish-provider");
  provider.apiKey = "synthetic-finish-key";
  const fallback = createApiProviderConfig("ollama", "finish-fallback");
  settings.apiProviders = [provider, fallback];
  activateApiProvider(settings, provider);
  let attempts = 0, saves = 0, refreshes = 0, rejectDelete = true;
  const plugin = withSettingsTabDefaults({ app: new App(), manifest: { id: "settings-finish" }, settings,
    saveSettings: async () => { saves++; },
    activateApiProviderSettings: async (mutate: (candidate: typeof settings) => void) => {
      attempts++;
      const candidate = structuredClone(settings);
      mutate(candidate);
      if (rejectDelete && candidate.apiProviders.length < settings.apiProviders.length) throw new Error("synthetic finish delete rejected");
      Object.assign(settings, candidate);
    }
  });
  const tab = new CodexSettingTab(plugin as never), mutable = tab as any;
  const rowSelector = `[data-echoink-focus-key="provider:${provider.id}:edit"]`;
  try {
    tab.display();
    const oauth = createApiProviderConfig("openai-codex", "finish-oauth");
    settings.apiProviders.push(oauth);
    for (const credential of [codexCredentialFixture("finish-valid"), { ...codexCredentialFixture("finish-refreshable"), expires: 1 }, null]) {
      settings.openAICodexCredential = credential;
      mutable.renderSettingsContent();
      const status = tab.containerEl.querySelector(`[data-echoink-focus-key="provider:${oauth.id}:edit"]`)!.querySelector(".codex-provider-connection-badge")!;
      assert.equal(status.hasClass(credential ? "is-signed-in" : "is-unverified"), true);
      assert.equal(status.textContent, credential ? "Signed in" : "Not verified");
      assert.doesNotMatch(status.textContent, /Sign in again|relogin|Connection verified/u,
        "an absent credential is not known revocation, and expired access remains refreshable without a new sign-in");
      assert.doesNotMatch(tab.containerEl.querySelector(rowSelector)!.querySelector(".codex-provider-connection-badge")!.textContent, /Sign in again|relogin/u,
        "a filled API key never implies OAuth revocation");
    }
    assert.equal(attempts, 0); assert.equal(saves, 0, "rendering OAuth validity never refreshes authorization or persists settings");
    settings.apiProviders = [provider, fallback];
    mutable.renderSettingsContent();
    const row = tab.containerEl.querySelector<ProviderModalTestElement>(rowSelector)!;
    assert.equal(row.tagName, "BUTTON", "the whole desktop row is the native keyboard/focus control");
    assert.equal(row.hasClass("codex-provider-saved-row"), true);
    assert.equal(row.querySelectorAll("button").length, 0, "the row contains no nested actions");
    assert.equal(row.querySelector(".codex-provider-model-count"), null);
    assert.equal(row.querySelector(".codex-provider-active-badge"), null);
    assert.equal(row.querySelector(".codex-provider-credential-badge"), null);
    assert.equal(row.querySelector(".codex-provider-saved-details")?.textContent, `${provider.models.length} models`);
    assert.match(row.querySelector(".codex-provider-connection-badge")!.textContent, /Not verified/u, "a filled key never becomes a verified connection");
    assert.ok(row.querySelector(".codex-provider-connection-badge")!.querySelector('[aria-hidden="true"]'), "connection text has an icon container");
    assert.ok(row.querySelector(".codex-provider-saved-arrow"));
    row.focus(); assert.equal(providerModalTestDocument.activeElement, row);
    row.click();
    const remove = () => tab.containerEl.querySelector<ProviderModalTestElement>('[data-modal-focus-key="provider-delete"]')!;
    assert.ok(remove()?.hasClass("echoink-delete-button"), "details use the common amicro delete button");
    const name = tab.containerEl.querySelector<ProviderModalTestElement>('[data-modal-focus-key="name"]')!;
    name.value = "Uncommitted finish draft"; name.fireEvent("input");
    remove().click();
    let confirmation = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-settings-inline-confirm")!;
    assert.match(confirmation.textContent, /active model.*switch to the next/u);
    confirmation.querySelectorAll<ProviderModalTestElement>("button")[0].click();
    assert.equal(attempts, 0); assert.equal(saves, 0, "canceling removal performs no write");
    const before = JSON.stringify(settings);
    const noticesBefore = openTestNoticeMessages.length;
    remove().click();
    confirmation = tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-settings-inline-confirm")!;
    confirmation.querySelectorAll<ProviderModalTestElement>("button")[1].click();
    await flushProviderModalTasks();
    assert.equal(attempts, 1);
    assert.equal(JSON.stringify(settings), before, "rejected removal preserves active provider and fallback settings");
    assert.ok(remove()); assert.equal(remove().disabled, false, "failed removal retains a live retry action after redraw");
    assert.equal(tab.containerEl.querySelector<ProviderModalTestElement>('[data-modal-focus-key="name"]')!.value, "Uncommitted finish draft");
    assert.match(tab.containerEl.querySelector(".codex-provider-modal-save-state")!.textContent, /not deleted/u);
    assert.ok(!openTestNoticeMessages.slice(noticesBefore).some(message => /removed|Now using/u.test(message)), "failure never reports deletion success");
    tab.containerEl.querySelector<ProviderModalTestElement>('[data-modal-focus-key="cancel"]')!.click();
    mutable.renderSettingsContent();
    assert.ok(tab.containerEl.querySelector(rowSelector));
    assert.equal((await mutable.saveAndActivateProviderModel(provider, "", true, provider)).saved, true);
    mutable.renderSettingsContent();
    assert.match(tab.containerEl.querySelector(rowSelector)!.querySelector(".codex-provider-connection-badge")!.textContent, /Connection verified/u);
    rejectDelete = false;
    tab.containerEl.querySelector<ProviderModalTestElement>(rowSelector)!.click(); remove().click();
    tab.containerEl.querySelector<ProviderModalTestElement>(".echoink-settings-inline-confirm")!.querySelectorAll<ProviderModalTestElement>("button")[1].click();
    await flushProviderModalTasks();
    assert.equal(tab.containerEl.querySelector('[data-modal-focus-key="provider-delete"]'), null, "successful removal closes the editor");
    assert.deepEqual(settings.apiProviders.map(item => item.id), [fallback.id]);
    assert.equal(settings.activeApiProviderId, fallback.id);

    mutable.resourceSnapshot = emptyWorkspaceResourceSnapshot(); mutable.resourceLoaded.mcp = true;
    mutable.loadWorkspaceResources = async () => { refreshes++; };
    resetSynchronousSettingsDisplayFrame(tab); tab.openDesktopRoute({ tab: "capabilities", capabilityTab: "mcp" });
    for (const count of [8, 9]) {
      const servers = Array.from({ length: count }, (_, index) => ({ ...mcpResourceFixture(`finish-${index}`, index === 0), bridgeMode: "native-mcp" as const }));
      settings.resources.catalog = servers; mutable.runtimeEchoInkResources = servers;
      for (const server of servers) settings.resources.mcpConnections[server.id] = { transport: "http", url: "https://mcp-finish.invalid", trusted: false, tools: [], toolPolicies: {} };
      mutable.resourceSearchQuery.mcp = "finish-0";
      mutable.renderSettingsContent();
      assert.equal(Boolean(tab.containerEl.querySelector('[data-echoink-focus-key="resources:search:mcp"]')), count > 8, "search uses all saved servers including disabled entries");
      if (count === 8) assert.equal(mutable.resourceSearchQuery.mcp, "", "a hidden search cannot silently filter the short list");
      const refresh = tab.containerEl.querySelector<ProviderModalTestElement>('[data-echoink-focus-key="resources:refresh"]')!;
      const add = tab.containerEl.querySelector<ProviderModalTestElement>('[data-echoink-focus-key="resources:mcp:add"]')!;
      assert.equal(refresh.parentElement, add.parentElement);
      assert.ok(refresh.closest(".codex-resource-list-header"));
      assert.equal(refresh.getAttribute("aria-label"), "Refresh");
      assert.equal(refresh.textContent, "", "desktop MCP refresh is an icon action");
      refresh.click(); assert.equal(refreshes, count === 8 ? 1 : 2);
      const state = tab.containerEl.querySelector(".codex-resource-connection-state")!;
      assert.match(state.textContent, /not yet verified/u, "a saved endpoint does not imply verification");
      assert.ok(state.querySelector('[aria-hidden="true"]'));
      if (count === 9) {
        mutable.applyResourceSearchFilter("mcp"); mutable.renderSettingsContent();
        assert.ok(tab.containerEl.querySelector('[data-echoink-focus-key="resources:search:mcp"]'), "filtered results never alter the search threshold");
      }
    }
    mutable.resourceLoadingTab = "mcp"; mutable.renderSettingsContent();
    const loading = tab.containerEl.querySelector<ProviderModalTestElement>('[data-echoink-focus-key="resources:refresh"]')!;
    assert.equal(loading.disabled, true); assert.equal(loading.getAttribute("aria-busy"), "true");
    assert.equal(saves, 0, "list navigation, search and deletion keep the existing authoritative activation path");
  } finally { tab.hide(); Platform.isDesktopApp = previousDesktop; }
  console.log("PASS desktop finish: whole model rows, real status, detail removal cancel/failure/success and MCP 8/9 search/header refresh");
}

async function assertSettingsRouteTargetsHostCopy(): Promise<void> {
  const previousDesktop = Platform.isDesktopApp;
  try {
    const plugin: any = Object.create(CodexForObsidianPlugin.prototype);
    plugin.manifest = { id: "echoink-host-copy-fixture" };
    plugin.settings = structuredClone(DEFAULT_SETTINGS);
    const calls: unknown[][] = [];
    const tab = (name: string, id = plugin.manifest.id) => ({ id,
      openDesktopRoute: (route: unknown) => { calls.push([name, "route", route]); },
      openLifestyleDetail: (kind: unknown) => { calls.push([name, "detail", kind]); }
    });
    const registered = tab("registered");
    const activeCopy = tab("active-copy");
    plugin.setSettingsTabInstance(registered);
    plugin.app = { setting: { activeTab: activeCopy,
      open: () => { calls.push(["host", "open"]); },
      openTabById: (id: string) => { calls.push(["host", "open-tab", id]); }
    } };
    plugin.saveSettings = async (immediate: boolean) => { calls.push(["save", immediate]); };
    const route = { tab: "capabilities", capabilityTab: "tools", focus: "providers/tools" } as const;
    Platform.isDesktopApp = true;
    plugin.prepareDesktopSettingsRoute(route);
    assert.deepEqual(calls, [["registered", "route", route], ["active-copy", "route", route]],
      "native search's visible same-id copy and detached registered tab both receive the public route");
    calls.length = 0;
    await plugin.openLifestyleSettings("finance");
    assert.deepEqual(calls, [
      ["registered", "route", { tab: "modules" }], ["active-copy", "route", { tab: "modules" }],
      ["registered", "detail", "finance"], ["active-copy", "detail", "finance"],
      ["save", true], ["host", "open"], ["host", "open-tab", plugin.manifest.id]
    ], "the same host copy receives the actual lifestyle detail after module routing");
    assert.equal(plugin.settings.settingsTab, "resources");
    assert.equal(plugin.settings.resourceManagementTab, "plugins");
    calls.length = 0;
    plugin.app.setting.activeTab = tab("other-plugin", "another-plugin");
    plugin.prepareDesktopSettingsRoute(route);
    assert.deepEqual(calls, [["registered", "route", route]], "an unrelated plugin's active tab is not routed");
    calls.length = 0;
    plugin.app.setting.activeTab = registered;
    plugin.prepareDesktopSettingsRoute(route);
    assert.deepEqual(calls, [["registered", "route", route]], "the registered active tab is not routed twice");
    calls.length = 0;
    plugin.app.setting.activeTab = activeCopy;
    Platform.isDesktopApp = false;
    plugin.prepareDesktopSettingsRoute(route);
    assert.deepEqual(calls, [], "mobile never receives a new desktop route");
  } finally { Platform.isDesktopApp = previousDesktop; }
  console.log("PASS P11 main navigation: same-id host copy and registered tab routed once; unrelated active tabs and mobile preserved");
}

async function assertOnboardingResumeSettingsRoute(): Promise<void> {
  const previousDesktop = Platform.isDesktopApp;
  try {
    for (const desktop of [false, true]) {
      Platform.isDesktopApp = desktop;
      for (const [step, tab] of [["provider", "providers"], ["knowledge", "knowledgeBase"], ["personality", "general"]] as const) {
        const plugin: any = Object.create(CodexForObsidianPlugin.prototype);
        plugin.settings = structuredClone(DEFAULT_SETTINGS);
        plugin.settings.setup.tutorialStep = step;
        plugin.onboardingRequested = true;
        const calls: unknown[][] = [];
        plugin.getViewService = () => ({ openEchoInkSettings: async (...args: unknown[]) => { calls.push(args); } });
        plugin.saveSettings = () => { throw new Error("resuming settings must not write configuration"); };
        await CodexForObsidianPlugin.prototype.openPendingEchoInkOnboarding.call(plugin);
        const focus = step === "personality" ? "general:personality-template" : step === "knowledge" ? "knowledge:onboarding" : "providers:add";
        assert.deepEqual(calls, [[tab, focus]], `resume ${step} routes to its actual editor/initialization target`);
        plugin.onboardingRequested = false;
        await CodexForObsidianPlugin.prototype.openPendingEchoInkOnboarding.call(plugin);
        assert.equal(calls.length, 1, "an inactive tutorial does not open settings");
      }
    }
  } finally { Platform.isDesktopApp = previousDesktop; }
  installProviderModalDomFixture();
  const plugin: any = Object.create(CodexForObsidianPlugin.prototype);
  plugin.app = new App(); plugin.settings = structuredClone(DEFAULT_SETTINGS); plugin.onboardingRequested = true;
  const anchor = providerModalTestDocument.body.createEl("button");
  const editor = providerModalTestDocument.body.createEl("div");
  let opened = 0, workspaces = 0;
  plugin.activateHomeAndSidebar = async () => { workspaces++; };
  plugin.getCodexView = () => ({ waitForTaskUiReady: async () => true, onboardingAgentAnchor: anchor, openOnboardingAgentEditor: () => { opened++; return editor; }, requestOnboardingEditorLeave: (done: () => void) => done() });
  plugin.saveSettings = () => { throw new Error("opening an onboarding target must not save configuration"); };
  const configuration = structuredClone(plugin.settings);
  await plugin.openPendingEchoInkOnboarding();
  assert.ok(providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark.is-sidebar"));
  assert.equal(plugin.settings.setup.tutorialStep, "sidebar");
  assert.equal(await plugin.handleEchoInkOnboardingTargetActivated("sidebar"), false, "ordinary ribbon/gear navigation is not Next");
  assert.equal(await plugin.handleEchoInkOnboardingTargetActivated("settings"), false);
  assert.deepEqual(plugin.settings, configuration);
  plugin.clearEchoInkOnboardingWorkspaceCoachmark(false);
  plugin.settings.setup.tutorialStep = "colleague";
  await plugin.openPendingEchoInkOnboarding();
  assert.equal(opened, 1); assert.equal(workspaces, 2);
  const coachmark = providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark.is-colleague");
  assert.ok(coachmark); assert.equal(coachmark.querySelector(".echoink-onboarding-action")?.textContent, "创建并完成");
  assert.equal(plugin.settings.setup.completedAt, 0); assert.equal(plugin.settings.agentRegistry.agents.length, configuration.agentRegistry.agents.length);
  plugin.clearEchoInkOnboardingWorkspaceCoachmark(false); anchor.remove(); editor.remove();
  console.log("PASS P15 onboarding resume: actual settings targets and workspace/colleague entry open without saving or executing");
}

async function assertOnboardingColleagueSubmitDelegation(): Promise<void> {
  const { AgentEditorController } = await import("../ui/codex-view/agent-editor");
  const oldPrepend = Object.getOwnPropertyDescriptor(ProviderModalTestElement.prototype, "prepend");
  Object.defineProperty(ProviderModalTestElement.prototype, "prepend", { configurable: true, value(this: ProviderModalTestElement, ...children: ProviderModalTestElement[]) {
    for (const child of children.reverse()) this.insertBefore(child, this.firstChild);
  } });
  const plugin: any = Object.create(CodexForObsidianPlugin.prototype);
  plugin.app = new App(); plugin.settings = structuredClone(DEFAULT_SETTINGS); plugin.onboardingRequested = true;
  plugin.settings.setup.tutorialStep = "colleague";
  let saveCalls = 0, delegations = 0, closes = 0, advances = 0;
  let finishSave!: () => void;
  const pendingSave = new Promise<void>(resolve => { finishSave = resolve; });
  const host = providerModalTestDocument.body.createDiv();
  const editor = new AgentEditorController({ settings: plugin.settings, draftCacheKey: plugin, onboarding: true,
    loadResources: async () => [], saveAgent: async agent => { saveCalls++; assert.equal(agent.name, "自定义同事"); await pendingSave; },
    deleteAgent: async () => { throw new Error("guided submit must not delete an Agent"); }, getDeleteCounts: async () => ({ total: 0, running: 0 }),
    onClose: () => { closes++; }
  });
  const view: any = Object.create(CodexView.prototype);
  view.taskEditor = editor; view.taskEditorOnboarding = true; view.rootEl = host; view.taskEditorEl = host;
  view.waitForTaskUiReady = async () => true;
  view.openOnboardingAgentEditor = () => host.querySelector(".echoink-agent-editor-header");
  view.submitOnboardingAgentEditor = () => { delegations++; return CodexView.prototype.submitOnboardingAgentEditor.call(view); };
  plugin.getCodexView = () => view; plugin.activateHomeAndSidebar = async () => undefined;
  plugin.saveSettings = async () => { throw new Error("the coachmark must delegate editor validation, not save tutorial progress"); };
  plugin.advanceEchoInkOnboarding = async (step: "colleague") => { advances++; return CodexForObsidianPlugin.prototype.advanceEchoInkOnboarding.call(plugin, step); };
  try {
    editor.open(); editor.render(host as never); await flushProviderModalTasks();
    assert.equal(host.querySelectorAll("button").filter(button => button.dataset.action === "save-agent").length, 0, "the guided form has no duplicate create action");
    const name = host.querySelectorAll<ProviderModalTestElement>("input").find(input => input.dataset.field === "name")!;
    name.value = ""; name.fireEvent("input");
    await plugin.openPendingEchoInkOnboarding();
    const card = providerModalTestDocument.body.querySelector<ProviderModalTestElement>(".echoink-onboarding-coachmark.is-colleague")!;
    assert.ok(card); assert.equal(card.querySelectorAll(".echoink-onboarding-action").length, 1);
    const create = card.querySelector<ProviderModalTestElement>(".echoink-onboarding-action")!;
    assert.equal(create.textContent, "创建并完成");
    create.click(); await flushProviderModalTasks();
    assert.equal(delegations, 1); assert.equal(saveCalls, 0); assert.equal(advances, 0); assert.equal(closes, 0);
    assert.equal(name.getAttribute("aria-invalid"), "true"); assert.equal(name.value, ""); assert.equal(card.isConnected, true);
    assert.equal(plugin.settings.setup.tutorialStep, "colleague"); assert.equal(plugin.settings.setup.completedAt, 0);
    name.value = "自定义同事"; name.fireEvent("input");
    create.click(); create.click(); await flushProviderModalTasks();
    assert.equal(delegations, 2, "one accepted valid attempt delegates through the real CodexView method once");
    assert.equal(saveCalls, 1); assert.equal(editor.isPending(), true); assert.equal(create.disabled, true);
    assert.equal(advances, 0, "the coachmark never calls ordinary advance to bypass the current editor");
    finishSave(); await flushProviderModalTasks();
    assert.equal(closes, 1); assert.equal(saveCalls, 1); assert.equal(plugin.settings.setup.completedAt, 0, "only the editor's durable host transaction may complete setup");
  } finally {
    finishSave(); editor.dispose(); plugin.clearEchoInkOnboardingWorkspaceCoachmark(false); host.remove();
    if (oldPrepend) Object.defineProperty(ProviderModalTestElement.prototype, "prepend", oldPrepend);
    else Reflect.deleteProperty(ProviderModalTestElement.prototype, "prepend");
  }
  console.log("PASS onboarding colleague: unique coachmark create delegates through real CodexView/editor, keeps validation and blocks repeated submit");
}

async function assertOnboardingNavigationPersistence(): Promise<void> {
  installProviderModalDomFixture();
  const plugin: any = Object.create(CodexForObsidianPlugin.prototype);
  plugin.conversationCatalogListeners = new Set<() => void>();
  plugin.agentRegistryListeners = new Set<() => void>();
  plugin.settings = structuredClone(DEFAULT_SETTINGS);
  plugin.onboardingRequested = true;
  let failSave = false;
  let saves = 0;
  plugin.saveSettings = async () => { saves += 1; if (failSave) throw new Error("save failed"); };
  const productConfiguration = structuredClone({
    providers: plugin.settings.apiProviders, knowledge: plugin.settings.knowledgeBase
  });
  await plugin.selectEchoInkOnboardingStep("sidebar", "personality");
  assert.equal(plugin.getEchoInkOnboardingStep(), "personality");
  assert.equal(plugin.settings.setup.completedAt, 0, "jumping is not completion");
  assert.equal(await plugin.selectEchoInkOnboardingStep("sidebar", "knowledge"), false);
  assert.equal(saves, 1, "stale controls do not save or advance again");
  const before = { ...plugin.settings.setup };
  failSave = true;
  await assert.rejects(plugin.selectEchoInkOnboardingStep("personality", "provider"), /save failed/);
  assert.deepEqual(plugin.settings.setup, before);
  await assert.rejects(plugin.advanceEchoInkOnboarding("personality"), /save failed/);
  assert.deepEqual(plugin.settings.setup, before);
  assert.equal(plugin.isEchoInkOnboardingRequested(), true);
  await assert.rejects(plugin.dismissEchoInkOnboarding(), /save failed/);
  assert.deepEqual(plugin.settings.setup, before);
  assert.equal(plugin.isEchoInkOnboardingRequested(), true);
  failSave = false;
  await plugin.advanceEchoInkOnboarding("personality");
  assert.equal(plugin.getEchoInkOnboardingStep(), "colleague");
  assert.equal(plugin.isEchoInkOnboardingRequested(), true);
  assert.equal(plugin.settings.setup.completedAt, 0);
  await assert.rejects(plugin.advanceEchoInkOnboarding("colleague"), /请先创建|create/iu, "the guide cannot bypass the colleague form");
  plugin.settings.agentRegistry.agents.push({ ...structuredClone(DEFAULT_SETTINGS.agentRegistry.agents[0]), id: "tutorial-colleague", name: "整理员" });
  plugin.settings.setup.onboardingAgentId = "tutorial-colleague";
  const colleagues = plugin.settings.agentRegistry.agents.length;
  await plugin.advanceEchoInkOnboarding("colleague");
  assert.equal(plugin.isEchoInkOnboardingRequested(), false);
  assert.equal(plugin.settings.setup.dismissedVersion, ECHOINK_ONBOARDING_VERSION);
  const completed = { ...plugin.settings.setup };
  failSave = true;
  await assert.rejects(plugin.restartEchoInkOnboarding(), /save failed/);
  assert.deepEqual(plugin.settings.setup, completed);
  assert.equal(plugin.isEchoInkOnboardingRequested(), false);
  failSave = false;
  await plugin.restartEchoInkOnboarding();
  assert.equal(plugin.getEchoInkOnboardingStep(), "sidebar");
  assert.equal(plugin.isEchoInkOnboardingRequested(), true);
  assert.equal(plugin.settings.setup.onboardingAgentId, "tutorial-colleague");
  assert.equal(plugin.settings.agentRegistry.agents.length, colleagues, "replay does not create another colleague");
  assert.deepEqual({ providers: plugin.settings.apiProviders, knowledge: plugin.settings.knowledgeBase }, productConfiguration);

  // Exercise the settings callbacks, including the real cursor persistence
  // method; only the host window opening/closing is recorded by this fixture.
  const routes: string[] = [];
  const app = new App();
  (app as any).setting = { close: () => routes.push("close-settings") };
  plugin.app = app;
  plugin.register = () => undefined;
  plugin.manifest = { id: "codex-echoink" };
  plugin.openPendingEchoInkOnboarding = async () => { routes.push(plugin.getEchoInkOnboardingStep()); };
  plugin.activateHomeAndSidebar = async () => { routes.push("workspace"); };
  plugin.openPaperGuideAfterOnboarding = async () => { routes.push("paper-guide"); };
  const tab = new CodexSettingTab(plugin);
  const mutable = tab as any;
  mutable.scheduleDisplay = () => undefined;
  mutable.activateSettingsTab = async (name: string) => { plugin.settings.settingsTab = name; routes.push(name); };
  const anchor = tab.containerEl.createEl("button", { attr: { "data-echoink-focus-key": "providers:add" } });
  anchor.focus();
  plugin.settings.setup.tutorialStep = "provider";
  mutable.renderOnboardingCoachmark("provider");
  providerModalTestDocument.body.querySelector<ProviderModalTestElement>(".echoink-onboarding-previous")!.click();
  await flushProviderModalTasks();
  assert.deepEqual(routes, ["sidebar", "close-settings"], "the target must open before the current settings host closes");
  assert.equal(plugin.getEchoInkOnboardingStep(), "sidebar");
  plugin.settings.setup.tutorialStep = "provider";
  mutable.renderOnboardingCoachmark("provider");
  const progress = providerModalTestDocument.body.querySelector<ProviderModalTestElement>(".echoink-onboarding-progress")!;
  progress.querySelectorAll<ProviderModalTestElement>("button")[4].click();
  await flushProviderModalTasks();
  assert.equal(plugin.getEchoInkOnboardingStep(), "colleague");
  assert.deepEqual(routes.slice(-2), ["colleague", "close-settings"]);
  mutable.showOnboardingCompletion();
  providerModalTestDocument.body.querySelector<ProviderModalTestElement>(".echoink-onboarding-previous")!.click();
  await flushProviderModalTasks();
  assert.equal(plugin.getEchoInkOnboardingStep(), "sidebar");
  assert.deepEqual(routes.slice(-2), ["sidebar", "close-settings"]);
  mutable.showOnboardingCompletion();
  providerModalTestDocument.body.querySelector<ProviderModalTestElement>(".echoink-onboarding-action")!.click();
  await flushProviderModalTasks();
  assert.deepEqual(routes.slice(-3), ["workspace", "close-settings", "paper-guide"]);

  // A failed dismissal stays visible, blocks concurrent clicks, and can retry.
  let rejectSave!: (reason: Error) => void;
  let dismissAttempts = 0;
  let reported = 0;
  const host = createOriginSelectHostFixture(providerModalTestDocument.defaultView as never);
  const hostEscape = () => host.dispatch({
    key: "Escape", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}
  } as unknown as KeyboardEvent);
  const guide = mountEchoInkOnboardingCoachmark({
    app: host.app,
    restoreFocusEl: anchor as never,
    anchor: anchor as never, stepClass: "provider", stepLabel: "03 / 05",
    title: "Connect a model", description: "Guide", actionLabel: "Next",
    dismissLabel: "Skip guide", onAction: () => undefined,
    onDismiss: async () => {
      dismissAttempts += 1;
      if (dismissAttempts === 1) await new Promise<void>((_, reject) => { rejectSave = reject; });
    },
    onActionError: () => { reported += 1; }
  });
  const close = (guide.element as unknown as ProviderModalTestElement).querySelector<ProviderModalTestElement>(".echoink-onboarding-dismiss")!;
  assert.equal(host.depth, 1, "guide owns the window keyboard scope");
  hostEscape();
  hostEscape();
  assert.equal(host.escapes, 0, "early host capture must not close settings");
  assert.equal(dismissAttempts, 1);
  assert.equal(close.disabled, true);
  rejectSave(new Error("save failed"));
  await flushProviderModalTasks();
  assert.equal(reported, 1);
  assert.equal(close.disabled, false);
  assert.equal(guide.element.isConnected, true);
  assert.equal(host.depth, 1, "failed saves retain the Escape handler for retry");
  hostEscape();
  await flushProviderModalTasks();
  assert.equal(guide.element.isConnected, false);
  assert.equal(host.depth, 0, "destroy restores the host window scope");
  assert.equal(host.escapes, 0);
  assert.equal(providerModalTestDocument.activeElement, anchor);
  hostEscape();
  assert.equal(host.escapes, 1, "after dismissal the host handles its own Escape again");
  host.dispose();
  assert.equal(providerModalTestDocument.body.querySelector(".echoink-onboarding-spotlight"), null);
  console.log("PASS onboarding: persisted back/jump/skip/complete/replay, rollback and retry");
}

async function assertOnboardingTargetSaveFailure(): Promise<void> {
  for (const source of ["sidebar", "provider"] as const) {
    const plugin: any = Object.create(CodexForObsidianPlugin.prototype);
    plugin.app = new App(); plugin.settings = structuredClone(DEFAULT_SETTINGS); plugin.onboardingRequested = true;
    plugin.settings.setup.tutorialStep = source;
    plugin.conversationCatalogListeners = new Set<() => void>(); plugin.agentRegistryListeners = new Set<() => void>();
    plugin.register = () => undefined; plugin.manifest = { id: "codex-echoink" };
    const before = structuredClone(plugin.settings.setup);
    let saves = 0, targetCalls = 0, targetReady = false, persisted = structuredClone(before);
    const savedSteps: string[] = [];
    plugin.saveSettings = async () => {
      saves++; savedSteps.push(plugin.settings.setup.tutorialStep);
      if (saves === 2) throw new Error("target-save-failed");
      persisted = structuredClone(plugin.settings.setup);
    };
    plugin.getViewService = () => ({ openEchoInkSettings: async () => {
      targetCalls++;
      // The target's route save happens after the tutorial cursor's first save.
      await plugin.saveSettings(true);
      targetReady = true;
    } });
    const anchor = providerModalTestDocument.body.createEl("button");
    plugin.activateHomeAndSidebar = async () => undefined;
    plugin.getCodexView = () => ({ waitForTaskUiReady: async () => true, onboardingAgentAnchor: anchor });
    let tab: CodexSettingTab | null = null;
    if (source === "sidebar") await plugin.openPendingEchoInkOnboarding();
    else {
      tab = new CodexSettingTab(plugin);
      tab.containerEl.createEl("button", { attr: { "data-echoink-focus-key": "providers:add" } });
      (tab as any).renderOnboardingCoachmark("provider");
    }
    const guide = providerModalTestDocument.body.querySelector<ProviderModalTestElement>(`.echoink-onboarding-coachmark.is-${source}`)!;
    assert.ok(guide);
    const next = guide.querySelector<ProviderModalTestElement>(".echoink-onboarding-action")!;
    next.click(); next.click(); await flushProviderModalTasks();
    assert.equal(saves, 3, `${source}: cursor save, failed target save, then persisted rollback`);
    assert.equal(targetCalls, 1); assert.equal(targetReady, false);
    assert.equal(guide.isConnected, true, `${source}: failed target keeps the same guide available`);
    assert.equal(next.disabled, false); assert.deepEqual(plugin.settings.setup, before); assert.deepEqual(persisted, before);
    assert.equal(plugin.isEchoInkOnboardingRequested(), true);
    assert.deepEqual(savedSteps, [source === "sidebar" ? "provider" : "knowledge", source === "sidebar" ? "provider" : "knowledge", source]);
    next.click(); await flushProviderModalTasks();
    assert.equal(saves, 5); assert.equal(targetCalls, 2); assert.equal(targetReady, true);
    assert.equal(plugin.getEchoInkOnboardingStep(), source === "sidebar" ? "provider" : "knowledge");
    assert.equal(persisted.tutorialStep, plugin.getEchoInkOnboardingStep());
    if (source === "sidebar") assert.equal(guide.isConnected, false, "workspace guide closes only after the settings target is ready");
    else (tab as any).clearOnboardingCoachmark(false);
    plugin.clearEchoInkOnboardingWorkspaceCoachmark(false); anchor.remove(); tab?.containerEl.remove();
  }
  console.log("PASS onboarding navigation: target's second save failure keeps workspace/settings guide, persists cursor rollback and retries");
}

async function assertOnboardingPersonalityHostRebuild(): Promise<void> {
  const previousDesktop = Platform.isDesktopApp; Platform.isDesktopApp = true;
  const oldPrepend = Object.getOwnPropertyDescriptor(ProviderModalTestElement.prototype, "prepend");
  Object.defineProperty(ProviderModalTestElement.prototype, "prepend", { configurable: true, value(this: ProviderModalTestElement, ...children: ProviderModalTestElement[]) {
    for (const child of children.reverse()) this.insertBefore(child, this.firstChild);
  } });
  const settings = structuredClone(DEFAULT_SETTINGS);
  const sol = settings.agentRegistry.agents[0]; sol.name = "自己的总助"; sol.styleId = "analysis";
  const saved = structuredClone(settings);
  const plugin = withSettingsTabDefaults({ app: new App(), manifest: { id: "codex-echoink" }, settings,
    saveSettings: async () => { throw new Error("opening Sol editor must not save configuration"); },
    buildRuntimeEchoInkResourceCatalog: async () => [], getAgentCapabilityAvailability: () => ({ available: true }),
    isEchoInkOnboardingRequested: () => true, getEchoInkOnboardingStep: () => "personality" as const
  });
  const tab = new CodexSettingTab(plugin as never), lifecycle = tab as any;
  lifecycle.scheduleDisplay = () => undefined;
  try {
    tab.openDesktopRoute({ tab: "agent", focus: "general:personality-template" });
    assert.equal(lifecycle.pendingDesktopAgentEditor, sol.id);
    assert.equal(lifecycle.desktopAgents, null, "route queues the editor until the host's content is ready");
    lifecycle.disposeSettingsView();
    assert.equal(lifecycle.pendingDesktopAgentEditor, sol.id, "the host's initial definition disposal must preserve the queued Sol editor");
    lifecycle.renderSettingsShell(); lifecycle.beginSettingsDisplay(); lifecycle.renderSettingsContent();
    await flushProviderModalTasks();
    assert.equal(lifecycle.pendingDesktopAgentEditor, null);
    assert.equal(lifecycle.desktopAgents?.isDetail, true);
    assert.ok(tab.containerEl.querySelector(".echoink-agent-settings-editor")?.querySelector(".echoink-agent-editor-header"), "the real Agent controller renders its detail after the shell rebuild");
    assert.equal(tab.containerEl.querySelectorAll<ProviderModalTestElement>("input").find(input => input.dataset.field === "name")?.value, "自己的总助");
    assert.equal(tab.containerEl.querySelector(".echoink-agent-settings-list"), null, "the guide target cannot fall back to the members summary");
    assert.deepEqual(settings.agentRegistry, saved.agentRegistry, "opening the editor preserves the current Sol identity/style and owners");
  } finally {
    lifecycle.disposeSettingsView(); tab.containerEl.remove(); Platform.isDesktopApp = previousDesktop;
    if (oldPrepend) Object.defineProperty(ProviderModalTestElement.prototype, "prepend", oldPrepend);
    else Reflect.deleteProperty(ProviderModalTestElement.prototype, "prepend");
  }
  console.log("PASS onboarding personality: queued Sol editor survives host dispose/shell rebuild and renders the actual detail");
}

async function assertOnboardingDoesNotLockSettingsNavigation(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  settings.settingsTab = "general";
  settings.setup.tutorialStep = "knowledge";
  const plugin = withSettingsTabDefaults({
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    isEchoInkOnboardingRequested: () => true,
    getEchoInkOnboardingStep: () => "knowledge" as const
  });
  const tab = new CodexSettingTab(plugin as never);
  const mutable = tab as unknown as {
    settingsVisible: boolean;
    refreshOnboardingCoachmark(): Promise<void>;
  };
  mutable.settingsVisible = true;

  await mutable.refreshOnboardingCoachmark();

  assert.equal(
    settings.settingsTab,
    "general",
    "an active tutorial must not force the user back from a manually selected settings tab"
  );
  assert.equal(
    providerModalTestDocument.body.querySelector(".echoink-onboarding-coachmark"),
    null,
    "the coachmark stays hidden until the user returns to the tutorial step"
  );
  console.log("PASS settings: onboarding never locks manual settings navigation");
}

async function assertManualOnboardingReopenIsRemoved(): Promise<void> {
  installProviderModalDomFixture();
  const fixtureState = createIdentityFixtureState();
  const { plugin } = createIdentityTestPlugin(fixtureState);
  plugin.settings.settingsTab = "general";
  const tab = new CodexSettingTab(withSettingsTabDefaults(plugin) as never);
  const mutable = tab as unknown as { personalMemoryState: Record<string, any> | null };
  mutable.personalMemoryState = structuredClone(fixtureState);
  tab.display();

  assert.doesNotMatch(
    tab.containerEl.textContent,
    /首次设置|重新打开|First-time setup|Reopen/u,
    "existing Vault settings must not expose a manual tutorial restart"
  );
  const bootstrapSource = readFileSync("src/plugin/bootstrap.ts", "utf8");
  assert.doesNotMatch(bootstrapSource, /open-echoink-onboarding|重新打开首次设置/u);
  console.log("PASS settings: manual onboarding reopen entry and command are removed");
}

async function assertRetiredSettingsRewritePersistence(): Promise<void> {
  const resource = {
    id: "manual:skill:retired-rewrite",
    kind: "skill" as const,
    source: "manual" as const,
    name: "Retired rewrite",
    description: "fixture",
    enabled: true,
    scopes: ["chat"] as const,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/retired-rewrite/SKILL.md"
  };
  let persisted: unknown = {
    ...structuredClone(DEFAULT_SETTINGS),
    settingsVersion: 48,
    defaultReasoning: "xhigh",
    mcpEnabled: true,
    agents: { hermes: { apiKey: "sentinel-not-a-real-key" } },
    knowledgeBase: {
      ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
      enabled: true,
      scheduleTime: "08:30",
      catchUpOnStartup: false
    },
    resources: {
      ...structuredClone(DEFAULT_SETTINGS.resources),
      catalog: [resource],
      enabledByScope: { chat: { [resource.id]: false } }
    }
  };
  let saveCount = 0;
  const plugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    getVaultPath: () => path.join(tmpdir(), "echoink-retired-settings-rewrite-fixture"),
    getPluginDataDirName: () => ".obsidian/plugins/echoink",
    loadData: async () => structuredClone(persisted),
    saveData: async (value: unknown) => {
      saveCount += 1;
      persisted = structuredClone(value);
    }
  };
  const store = new EchoInkSettingsStore(plugin as never);
  await store.loadSettings();
  assert.equal(saveCount, 1);
  const serialized = JSON.stringify(persisted);
  assert.doesNotMatch(serialized, /sentinel-not-a-real-key/u);
  const data = persisted as Record<string, any>;
  assert.equal(Object.hasOwn(data, "agents"), false, "retired top-level Agent settings must be removed");
  assert.equal(Object.hasOwn(data, "hermes"), false, "retired top-level Hermes settings must be removed");
  assert.ok(Array.isArray(data.agentRegistry.agents), "the current registry retains its legitimate agents array");
  assert.ok(data.agentRegistry.agents.some((agent: { id: string }) => agent.id === "sol"));
  assert.equal(Object.hasOwn(data.knowledgeBase, "enabled"), false);
  assert.equal(Object.hasOwn(data.knowledgeBase, "scheduleTime"), false);
  assert.equal(Object.hasOwn(data.knowledgeBase, "catchUpOnStartup"), false);
  assert.equal(Object.hasOwn(data.resources, "enabledByScope"), false);
  assert.equal(Object.hasOwn(data.resources.catalog[0], "scopes"), false);
  assert.equal(data.resources.catalog[0].enabled, false);
  assert.equal(Object.hasOwn(data, "mcpEnabled"), false);
  assert.equal(Object.hasOwn(data, "defaultReasoning"), false);
}

async function assertMcpPanelUsesTurnResourceTruth(): Promise<void> {
  installProviderModalDomFixture();
  const createHost = (catalog: ReturnType<typeof mcpResourceFixture>[]) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.resources.catalog = structuredClone(catalog);
    return {
      app: new App(),
      plugin: { settings },
      running: false,
      selectedProviderSettingsId: "",
      selectedModel: "",
      selectedPermission: settings.defaultPermission,
      selectedMode: settings.defaultMode,
      ensureSession: () => settings.sessions[0],
      renderToolbar: () => undefined,
      renderMessages: () => undefined,
      updateInputPlaceholder: () => undefined,
      currentTurnOptions: () => currentTurnOptions({} as never),
      effectiveModel: () => "fixture-model"
    };
  };
  const render = (
    catalog: ReturnType<typeof mcpResourceFixture>[],
    error: string | null = null
  ) => {
    const host = createHost(catalog);
    const container = document.createElement("div");
    let retries = 0;
    const state = mcpResourceEnablement(catalog);
    renderMcpPanelView(container, error, state, {
      onRetry: () => { retries += 1; }
    });
    return { host, container, retries: () => retries };
  };

  const empty = render([]);
  assert.equal(empty.container.getAttribute("role"), "region");
  assert.equal(empty.container.getAttribute("aria-labelledby"), "echoink-mcp-panel-title");
  assert.equal(
    empty.container.querySelector(".codex-mcp-title")?.getAttribute("id"),
    "echoink-mcp-panel-title"
  );
  assert.match(empty.container.textContent, /当前没有 MCP 资源/u);
  const emptyStatus = empty.container.querySelector(".codex-mcp-empty");
  assert.ok(emptyStatus);
  assert.equal(emptyStatus.getAttribute("role"), "status");
  assert.equal(emptyStatus.getAttribute("aria-live"), "polite");
  assert.equal(currentTurnOptions(empty.host as never).mcpEnabled, false);

  const disabledCatalog = [mcpResourceFixture("disabled-a", false), mcpResourceFixture("disabled-b", false)];
  const disabled = render(disabledCatalog);
  assert.match(disabled.container.textContent, /当前 2 个 MCP 资源均已关闭/u);
  assert.equal(currentTurnOptions(disabled.host as never).mcpEnabled, false);

  const partialCatalog = [mcpResourceFixture("enabled", true), mcpResourceFixture("disabled", false)];
  const partial = render(partialCatalog);
  assert.match(partial.container.textContent, /当前已启用 1 \/ 2 个 MCP 资源/u);
  assert.match(partial.container.textContent, /Server 与 Tool 信任策略/u);
  assert.equal(currentTurnOptions(partial.host as never).mcpEnabled, true);

  const error = render(partialCatalog, "fixture scan failed");
  assert.match(error.container.textContent, /读取失败：fixture scan failed/u);
  assert.doesNotMatch(error.container.textContent, /当前已启用|均已关闭|没有读取到/u);
  assert.equal(error.container.querySelector(".codex-mcp-error")?.getAttribute("role"), "alert");
  assert.equal(error.container.querySelector(".codex-mcp-empty"), null);
  const retry = error.container.querySelector<HTMLButtonElement>(".codex-mcp-retry");
  assert.ok(retry);
  assert.equal(retry.textContent, "重新读取 MCP");
  assert.equal(retry.getAttribute("type"), "button");
  assert.equal(retry.getAttribute("aria-label"), "重新读取 MCP");
  retry.click();
  assert.equal(error.retries(), 1);

  const loaderContainer = document.createElement("div");
  let loaderReads = 0;
  const loaderInput = {
    container: loaderContainer,
    loadResources: () => {
      loaderReads += 1;
      if (loaderReads === 1) throw new Error("fixture catalog failed");
      return { total: 2, enabled: 1 };
    }
  };
  await assert.doesNotReject(loadMcpPanelView(loaderInput));
  assert.equal(loaderReads, 1);
  assert.match(loaderContainer.textContent, /读取失败：fixture catalog failed/u);
  assert.equal(loaderContainer.querySelector(".codex-mcp-error")?.getAttribute("role"), "alert");
  assert.equal(loaderContainer.querySelector(".codex-mcp-empty"), null);
  const loaderRetry = loaderContainer.querySelector<HTMLButtonElement>(".codex-mcp-retry");
  assert.ok(loaderRetry);
  loaderRetry.click();
  await flushProviderModalTasks();
  assert.equal(loaderReads, 2);
  assert.doesNotMatch(loaderContainer.textContent, /读取失败/u);
  assert.match(loaderContainer.textContent, /当前已启用 1 \/ 2 个 MCP 资源/u);

  assert.doesNotMatch(readFileSync("src/settings/i18n.ts", "utf8"), /mcpDisabledWarning|chat MCP master switch|聊天 MCP 总开关/u);
  assert.doesNotMatch(readFileSync("src/settings/settings.ts", "utf8"), /^\s*mcpEnabled\??:/mu);
  assert.match(readFileSync("src/ui/turn-options.ts", "utf8"), /^\s*mcpEnabled:/mu);
}

function mcpResourceFixture(id: string, enabled: boolean) {
  return {
    id: `manual:mcp-server:${id}`,
    kind: "mcp-server" as const,
    source: "manual" as const,
    name: id,
    description: "fixture",
    enabled,
    bridgeMode: "native" as const
  };
}

async function assertKnowledgeSettingsDetailRetiresLegacyControls(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsLanguage = "zh-CN";
  settings.settingsTab = "knowledgeBase";
  const preference = Object.freeze({
    profileVersion: ECHOINK_KNOWLEDGE_PREFERENCE_PROFILE_VERSION,
    state: "custom" as const,
    revision: `sha256:${"a".repeat(64)}`,
    content: "# 自定义偏好\n\n优先保留失败、反例和决策边界。\n"
  });
  const plugin = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    saveSettings: async () => undefined,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getEchoInkKnowledgeMaintenancePreferenceState: async () => preference,
    saveEchoInkKnowledgeMaintenancePreferences: async () => preference,
    getEchoInkKnowledgeInitializationState: async () => null,
    isEchoInkOnboardingRequested: () => false,
    getEchoInkOnboardingStep: () => "provider" as const,
    advanceEchoInkOnboarding: async () => null,
    dismissEchoInkOnboarding: async () => undefined
  };
  const host = withSettingsTabDefaults(plugin);
  const tab = new CodexSettingTab(host as never);
  const mutableTab = tab as unknown as {
    knowledgePreferenceState: typeof preference;
    knowledgePreferenceEditor: ReturnType<typeof createKnowledgeMaintenancePreferenceEditor>;
    renderKnowledgeMaintenancePreferences(container: HTMLElement): void;
  };
  mutableTab.knowledgePreferenceState = preference;
  mutableTab.knowledgePreferenceEditor = createKnowledgeMaintenancePreferenceEditor(preference);
  const knowledge = new DesktopKnowledgeSettings(host as never, {
    redraw() { tab.containerEl.empty(); if (knowledge.isDetail) knowledge.renderDetail(tab.containerEl); else knowledge.renderSummary(tab.containerEl); },
    openLinking() {}, openEditor() {},
    openPreferences() { tab.containerEl.empty(); mutableTab.renderKnowledgeMaintenancePreferences(tab.containerEl); }
  });
  knowledge.renderSummary(tab.containerEl);
  assert.equal(tab.containerEl.querySelectorAll(".echoink-knowledge-purpose-row").length, 4,
    "the production module exposes only Raw, Wiki, Projects and Inbox");
  assert.equal(tab.containerEl.querySelector(".echoink-folder-purpose"), null);
  assert.equal(tab.containerEl.querySelector(".echoink-knowledge-init-panel"), null);
  assert.equal(tab.containerEl.querySelector('[data-echoink-focus-key="knowledge:provider"]'), null,
    "Knowledge uses the global model page");
  assertLegacyKnowledgeControlsAbsent(tab.containerEl.textContent);
  assert.equal(tab.containerEl.querySelector('[data-echoink-focus-key="knowledge:preferences"]'), null, "refinement preferences live under Agent permissions and maintenance");
  const permissionsNavigation = tab.containerEl.querySelector<HTMLButtonElement>('[data-echoink-focus-key="knowledge:permissions"]');
  assert.ok(permissionsNavigation); permissionsNavigation.click();
  assert.equal(tab.containerEl.querySelector("h2")?.textContent, "Agent 权限与维护");
  const preferenceNavigation = tab.containerEl.querySelector<HTMLButtonElement>('[data-echoink-focus-key="knowledge:preferences"]');
  assert.ok(preferenceNavigation);
  preferenceNavigation.click();

  const steps = tab.containerEl.querySelectorAll(
    ".echoink-knowledge-protocol-item"
  );
  assert.equal(steps.length, 6);
  assert.match(tab.containerEl.textContent, /固定提炼步骤/u);
  assert.match(tab.containerEl.textContent, /自检、安全写入与回读/u);
  assert.doesNotMatch(
    tab.containerEl.textContent,
    /长期记忆|Personal Memory/u,
    "the reachable Knowledge refinement detail must not expose Personal Memory state or boundaries"
  );
  assert.doesNotMatch(tab.containerEl.textContent, /待确认预览|确认时仍提交原预览/u);
  const textarea = tab.containerEl.querySelector<HTMLTextAreaElement>(
    ".echoink-knowledge-preference-textarea"
  );
  const restore = tab.containerEl.querySelector<HTMLButtonElement>(
    '[data-echoink-focus-key="knowledge:preferences:restore"]'
  );
  const save = tab.containerEl.querySelector<HTMLButtonElement>(
    '[data-echoink-focus-key="knowledge:preferences:save"]'
  );
  const status = tab.containerEl.querySelector(
    ".echoink-knowledge-preference-status"
  );
  assert.ok(textarea);
  assert.ok(restore);
  assert.ok(save);
  assert.ok(status);
  assert.equal(textarea.value, preference.content);
  assert.match(status.textContent, /已自定义 · 已保存/u);
  assert.equal(save.disabled, true);

  textarea.value = `${preference.content}\n新增关注维度。`;
  textarea.oninput?.(new Event("input"));
  assert.match(status.textContent, /有未保存修改/u);
  assert.equal(save.disabled, false);
  restore.click();
  assert.equal(
    textarea.value,
    ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
  );
  assert.match(status.textContent, /使用 EchoInk 默认 · 有未保存修改/u);
  assert.equal(restore.disabled, true);
  assertLegacyKnowledgeControlsAbsent(tab.containerEl.textContent);
}

function assertLegacyKnowledgeControlsAbsent(text: string): void {
  for (const retired of [
    "LLM-WIKI.md",
    "规则文件路径",
    "修复规则文件",
    "打开规则文件",
    "定时维护",
    "启动补跑"
  ]) {
    assert.doesNotMatch(text, new RegExp(retired, "u"), retired);
  }
}

// ---------------------------------------------------------------------------
// Production directory transactions are covered by module-folder-storage.
// Keep the shared note picker regression independent of the retired panel.
// ---------------------------------------------------------------------------


function makeKnowledgeBaseStructureFixture(
  state: "uninitialized" | "incomplete" | "ready",
  overrides: Record<string, unknown> = {}
): Record<string, any> {
  const roots = [...KNOWLEDGE_INITIALIZATION_ROOTS];
  const base = state === "ready"
    ? { existingRoots: roots, missingRoots: [], conflictingRoots: [] }
    : state === "incomplete"
      ? {
          existingRoots: ["raw", "wiki"],
          missingRoots: roots.filter((root) => root !== "raw" && root !== "wiki"),
          conflictingRoots: []
        }
      : { existingRoots: [], missingRoots: roots, conflictingRoots: [] };
  return { state, ...base, checkedAt: 1, ...overrides };
}


/**
 * 测试 DOM 的 requestAnimationFrame 是同步的：一次 scheduleDisplay 之后
 * displayFrame 会停在非空值。这里先冲刷微任务，再用 display() 做一次干净
 * 的重渲染并复位 displayFrame，模拟真实环境里的下一帧。
 */


function resetSynchronousSettingsDisplayFrame(tab: CodexSettingTab): void {
  (tab as unknown as { displayFrame: number | null }).displayFrame = null;
}


async function assertKnowledgeInitNotePickerModalContract(): Promise<void> {
  installProviderModalDomFixture();
  const app = new App();
  const trigger = providerModalTestDocument.body.createEl("button", { text: "添加笔记" });
  const assignments: unknown[] = [];
  const notes = [
    { sourcePath: "notes/alpha.md", role: "wiki" as const },
    { sourcePath: "notes/beta.md", role: "raw" as const },
    { sourcePath: "notes/delta.md", role: "projects" as const },
    { sourcePath: "notes/gamma.md", role: "raw" as const },
    { sourcePath: "notes/10.md", role: "raw" as const },
    { sourcePath: "notes/2.md", role: "raw" as const },
    { sourcePath: "notes/kept.md", role: "keep" as const }
  ];
  const openPicker = (targetRole: "raw" | "wiki" = "wiki", onConfirm = async (value: unknown) => { assignments.push(value); }) => {
    const modal = new KnowledgeNotePickerModal(app, { zh: true, targetRole, targetLabel: targetRole === "wiki" ? "知识库 / Wiki" : "Raw", notes,
      onConfirm, restoreFocus: () => trigger.focus() });
    modal.open(); return modal;
  };
  const nativeOpen = Modal.prototype.open;
  Modal.prototype.open = function () { nativeOpen.call(this); this.contentEl.querySelector<HTMLElement>(".picker-close")?.focus(); };
  let modal: KnowledgeNotePickerModal;
  try { modal = openPicker(); } finally { Modal.prototype.open = nativeOpen; }
  const search = modal.contentEl.querySelector<ProviderModalTestElement>(".echoink-knowledge-note-picker-search")!;
  assert.equal(providerModalTestDocument.activeElement, search, "search survives the host's initial focus pass");
  const rows = () => modal.contentEl.querySelectorAll<ProviderModalTestElement>(".echoink-knowledge-note-picker-row");
  assert.deepEqual(rows().map(row => row.getAttribute("data-note-path")), ["notes/2.md", "notes/10.md", "notes/beta.md", "notes/delta.md", "notes/gamma.md"]);
  const confirm = modal.contentEl.querySelector<ProviderModalTestElement>(".echoink-knowledge-note-picker-confirm")!;
  const all = modal.contentEl.querySelector<ProviderModalTestElement>(".picker-select-visible")!;
  const checkbox = (path: string) => rows().find(row => row.getAttribute("data-note-path") === path)!.querySelector<ProviderModalTestElement>(".echoink-knowledge-note-picker-checkbox")!;
  assert.equal(confirm.disabled, true);
  search.value = "beta"; search.fireEvent("input"); all.checked = true; all.fireEvent("change");
  search.value = "delta"; search.fireEvent("input"); assert.equal(all.checked, false);
  checkbox("notes/delta.md").checked = true; checkbox("notes/delta.md").fireEvent("change");
  search.value = ""; search.fireEvent("input");
  assert.equal(all.indeterminate, true); assert.equal(checkbox("notes/beta.md").checked, true);
  assert.equal(confirm.textContent, "添加到 知识库 / Wiki（2）");
  search.value = "does-not-exist"; search.fireEvent("input");
  assert.match(modal.contentEl.textContent, /没有匹配的笔记/u); assert.equal(all.disabled, true);
  assert.equal(confirm.textContent, "添加到 知识库 / Wiki（2）");
  search.value = "notes/"; search.fireEvent("input"); assert.equal(rows().length, 5); assert.equal(assignments.length, 0);
  search.focus(); modal.modalEl.fireEvent("keydown", { key: "Tab", shiftKey: true });
  assert.equal(providerModalTestDocument.activeElement, modal.contentEl.querySelector(".picker-close"));
  modal.modalEl.fireEvent("keydown", { key: "Tab", shiftKey: true }); assert.equal(providerModalTestDocument.activeElement, confirm);
  confirm.click(); await flushProviderModalTasks();
  assert.deepEqual(assignments, [[{ sourcePath: "notes/beta.md", role: "wiki" }, { sourcePath: "notes/delta.md", role: "wiki" }]]);
  assert.equal(openTestModals.length, 0); assert.equal(providerModalTestDocument.activeElement, trigger);

  const cancelled = openPicker();
  const cancelledChoice = cancelled.contentEl.querySelector<ProviderModalTestElement>(".echoink-knowledge-note-picker-checkbox")!;
  cancelledChoice.checked = true; cancelledChoice.fireEvent("change"); cancelled.modalEl.fireEvent("keydown", { key: "Escape" });
  await flushProviderModalTasks(); assert.equal(assignments.length, 1); assert.equal(openTestModals.length, 0);
  assert.equal(providerModalTestDocument.activeElement, trigger);

  let fail = true;
  const retry = openPicker("raw", async value => { if (fail) throw new Error("保存失败"); assignments.push(value); });
  assert.deepEqual(retry.contentEl.querySelectorAll<ProviderModalTestElement>(".echoink-knowledge-note-picker-row").map(row => row.getAttribute("data-note-path")), ["notes/alpha.md", "notes/delta.md"],
    "Raw has candidate-only semantics too; existing assignments and keep remain excluded");
  const retryChoice = retry.contentEl.querySelector<ProviderModalTestElement>(".echoink-knowledge-note-picker-checkbox")!;
  retryChoice.checked = true; retryChoice.fireEvent("change");
  const retryConfirm = retry.contentEl.querySelector<ProviderModalTestElement>(".echoink-knowledge-note-picker-confirm")!;
  retryConfirm.click(); await flushProviderModalTasks();
  assert.equal(openTestModals.at(-1), retry); assert.match(retry.contentEl.textContent, /没有保存成功，请再试一次/u); assert.equal(retryConfirm.disabled, false);
  fail = false; retryConfirm.click(); await flushProviderModalTasks(); assert.equal(openTestModals.length, 0);
  assert.deepEqual(assignments[1], [{ sourcePath: "notes/alpha.md", role: "raw" }]);

  const empty = new KnowledgeNotePickerModal(app, { zh: true, targetRole: "wiki", targetLabel: "Wiki", notes: [], onConfirm: async () => undefined });
  empty.open(); assert.match(empty.contentEl.textContent, /没有其他可分配的 Markdown 笔记/u);
  assert.doesNotMatch(empty.contentEl.textContent, /没有匹配的笔记/u); empty.close(); trigger.remove();
  console.log("PASS note picker: candidates, natural sort, filtering, focus, cancel, batch save and retry");
}

/**
 * 修复1/2/3 回归：
 * - 渲染优先级：settings 已 initialized 也不能遮住新的未完成作业；
 *   无 job 时由真实目录结构决定完成态。
 * - 恢复动作按结构化字段派生：blocked_conflict 不出现「继续初始化」；
 *   Provider 缺失 / digest 不一致 → 「重新检查并继续」。
 * - 用户动作失败必须可见可重试（actionError + 技术详情）。
 */


/**
 * 修复5/3 回归：Raw 目录选择器是「移回 Raw」语义——
 * 已在 Raw 的笔记只读展示、无预勾选；提交失败时 Modal 保持打开、
 * 显示内联错误且可以再次提交。
 */


function assertNewProductGenerationKeepsConfigurationButDropsLegacyHistory(): void {
  const provider = createApiProviderConfig("deepseek", "retained-provider");
  provider.apiKey = "retained-provider-api-key";
  const retainedSkill = {
    id: "skill-retained",
    kind: "skill" as const,
    source: "manual" as const,
    name: "Retained Skill",
    description: "retained",
    enabled: true,
    bridgeMode: "prompt-only" as const,
    contentPath: "skills/retained/SKILL.md"
  };
  const retainedResources = {
    ...structuredClone(DEFAULT_SETTINGS.resources),
    catalog: [retainedSkill],
    enabledByScope: {
      chat: { [retainedSkill.id]: true, "tool-bundle:echoink-vault": true }
    },
    mcpConnections: {
      "mcp-retained": {
        transport: "http" as const,
        url: "https://example.invalid/mcp",
        trusted: true,
        toolPolicies: {},
        credential: {
          credentialRef: `cred-${"c".repeat(32)}`,
          purpose: "mcp_header" as const,
          targetName: "Authorization",
          endpointRevision: 1
        },
        tools: []
      }
    }
  };
  const legacyInput = {
    ...structuredClone(DEFAULT_SETTINGS),
    productGeneration: undefined,
    activeApiProviderId: provider.id,
    providerRef: `provider-${"a".repeat(32)}`,
    credentialRef: `cred-${"b".repeat(32)}`,
    apiProviders: [provider],
    resources: retainedResources,
    sessions: [{
      id: "legacy-session",
      title: "legacy",
      kind: "chat",
      messages: []
    }],
    activeSessionId: "legacy-session",
    knowledgeBase: {
      ...structuredClone(DEFAULT_SETTINGS.knowledgeBase),
      sessionId: "legacy-session",
      lastRunAt: 123,
      lastRunStatus: "success",
      lastReportPath: "outputs/legacy.md",
      processedSources: { "raw/legacy.md": { path: "raw/legacy.md" } }
    }
  };

  const normalized = normalizeSettingsData(legacyInput).settings;
  assert.equal(normalized.productGeneration, "pi-agent-product-v1");
  assert.equal(normalized.activeApiProviderId, provider.id);
  assert.equal(normalized.apiProviders[0]?.apiKey, provider.apiKey);
  assert.equal(Object.hasOwn(normalized.apiProviders[0] ?? {}, "providerRef"), false);
  assert.equal(Object.hasOwn(normalized.apiProviders[0] ?? {}, "credentialRef"), false);
  assert.equal(normalized.resources.catalog[0]?.id, retainedSkill.id);
  assert.equal(normalized.resources.catalog[0]?.enabled, true);
  assert.equal(Object.hasOwn(normalized.resources, "enabledByScope"), false);
  assert.equal(normalized.resources.mcpConnections["mcp-retained"]?.credential?.credentialRef, retainedResources.mcpConnections["mcp-retained"].credential.credentialRef);
  assert.deepEqual(normalized.sessions, []);
  assert.equal(normalized.activeSessionId, "");
  assert.equal(normalized.knowledgeBase.lastRunAt, 0);
  assert.equal(normalized.knowledgeBase.lastRunStatus, "idle");
  assert.equal(normalized.knowledgeBase.lastReportPath, "");
  assert.deepEqual(normalized.knowledgeBase.processedSources, {});

  const currentGenerationWithRetiredKnowledgeShell = {
    ...structuredClone(DEFAULT_SETTINGS),
    productGeneration: "pi-agent-product-v1",
    activeApiProviderId: provider.id,
    apiProviders: [provider],
    sessions: [
      {
        id: "retired-knowledge-session",
        title: "Knowledge",
        kind: "knowledge-base",
        messages: []
      },
      {
        id: "current-conversation",
        title: "Current",
        messages: []
      }
    ],
    activeSessionId: "retired-knowledge-session"
  };
  const currentNormalized = normalizeSettingsData(currentGenerationWithRetiredKnowledgeShell).settings;
  assert.equal(currentNormalized.activeApiProviderId, provider.id);
  assert.equal(currentNormalized.apiProviders[0]?.apiKey, provider.apiKey);
  assert.deepEqual(currentNormalized.sessions.map((session) => session.id), ["current-conversation"]);
  assert.equal(currentNormalized.activeSessionId, "current-conversation");
}

function assertPresetRequestMappings(): void {
  for (const preset of API_PROVIDER_PRESETS) {
    const configuration = createApiProviderConfig(preset.id, `${preset.id}-fixture`);
    if (!configuration.baseUrl) continue;
    const url = apiProviderRequestUrl(configuration.baseUrl, configuration.apiProtocol);
    assert.ok(url.startsWith(configuration.baseUrl));
    assert.ok(url.length > configuration.baseUrl.length);
  }
}

function assertAnthropicProviderContract(): void {
  const anthropic = getApiProviderPreset("anthropic");
  assert.deepEqual({
    group: anthropic.group,
    runtimeProviderId: anthropic.runtimeProviderId,
    baseUrl: anthropic.baseUrl,
    apiProtocol: anthropic.apiProtocol,
    modelDiscovery: anthropic.modelDiscovery
  }, {
    group: "provider",
    runtimeProviderId: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiProtocol: "anthropic-messages",
    modelDiscovery: "supported"
  });
  assert.deepEqual(anthropic.models.map((model) => model.id), [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001"
  ]);
  assert.equal(apiProviderRequestUrl(
    anthropic.baseUrl,
    anthropic.apiProtocol
  ), "https://api.anthropic.com/v1/messages");
  assert.match(providerBrandSvg("anthropic"), /claudeGrad/u);
}

function assertQwenProviderContract(): void {
  const qwen = API_PROVIDER_PRESETS.find((preset) => preset.id === "qwen");
  const tokenPlan = API_PROVIDER_PRESETS.find(
    (preset) => preset.id === "qwen-token-plan"
  );
  assert.ok(qwen && tokenPlan);
  assert.deepEqual({
    group: qwen.group,
    runtimeProviderId: qwen.runtimeProviderId,
    baseUrl: qwen.baseUrl,
    apiProtocol: qwen.apiProtocol
  }, {
    group: "provider",
    runtimeProviderId: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiProtocol: "openai-completions"
  });
  assert.deepEqual({
    group: tokenPlan.group,
    runtimeProviderId: tokenPlan.runtimeProviderId,
    baseUrl: tokenPlan.baseUrl,
    apiProtocol: tokenPlan.apiProtocol
  }, {
    group: "token-plan",
    runtimeProviderId: "qwen-token-plan-cn",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    apiProtocol: "openai-completions"
  });
  assert.equal(
    isQwenTokenPlanApiProviderUrl(QWEN_TOKEN_PLAN_API_BASE_URL),
    true
  );
  assert.equal(
    isQwenTokenPlanApiProviderUrl(`${QWEN_TOKEN_PLAN_API_BASE_URL}/`),
    true
  );
  assert.equal(isQwenTokenPlanApiProviderUrl(
    "https://token-plan.cn-beijing.maas.aliyuncs.com:443/compatible-mode/v1"
  ), true);
  for (const invalidUrl of [
    "http://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://token-plan.cn-beijing.maas.aliyuncs.com:444/compatible-mode/v1",
    "https://token-plan.cn-beijing.maas.aliyuncs.com.example/compatible-mode/v1",
    `${QWEN_TOKEN_PLAN_API_BASE_URL}/models`,
    `${QWEN_TOKEN_PLAN_API_BASE_URL}?fixture=1`,
    `${QWEN_TOKEN_PLAN_API_BASE_URL}#fixture`,
    "https://fixture@token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
  ]) {
    assert.equal(isQwenTokenPlanApiProviderUrl(invalidUrl), false, invalidUrl);
  }

  const qwenSvg = providerBrandSvg("qwen");
  assert.equal(providerBrandSvg("qwen-token-plan"), qwenSvg);
  assert.match(qwenSvg, /<linearGradient\b/u);
  assert.ok(new Set(
    Array.from(qwenSvg.matchAll(/stop-color="(#[0-9A-F]{6})"/giu))
      .map((match) => match[1])
  ).size >= 2);

  const [catalogModelId] = Object.keys(QWEN_TOKEN_PLAN_CN_MODELS);
  assert.ok(catalogModelId);
  const resolvedCatalogModel = resolveEchoInkPiCatalogModel(
    "qwen-token-plan-cn",
    catalogModelId
  );
  assert.ok(resolvedCatalogModel);
  assert.equal(resolvedCatalogModel.id, catalogModelId);
  assert.equal(resolvedCatalogModel.provider, "qwen-token-plan-cn");
  assert.equal(
    resolvedCatalogModel.contextWindow,
    QWEN_TOKEN_PLAN_CN_MODELS[catalogModelId]?.contextWindow
  );
  assert.equal(resolveEchoInkPiCatalogModel("qwen", catalogModelId), null);

  const settings = structuredClone(DEFAULT_SETTINGS);
  const configured = createApiProviderConfig(
    "qwen-token-plan",
    "composer-qwen-token-plan"
  );
  settings.apiProviders = [configured];
  settings.activeApiProviderId = configured.id;
  assert.equal(currentComposerProviderBrand({
    plugin: { settings }
  } as never), "qwen");
}

async function assertProviderOutputLimitContract(): Promise<void> {
  const model = createPiProviderModelDefinition({
    providerId: "deepseek",
    apiProtocol: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    modelRef: "fixture-output-limit",
    reasoning: true
  });
  const assistant = (
    stopReason: AssistantMessage["stopReason"],
    content: AssistantMessage["content"]
  ): AssistantMessage => ({
    ...fixtureAssistantMessage(model), stopReason, content
  });
  const toolCall = (id: string) => ({
    type: "toolCall" as const, id, name: "note_read", arguments: {}
  });
  const toolResult = (id: string, isError = false): Context["messages"][number] => ({
    role: "toolResult", toolCallId: id, toolName: "note_read",
    content: [{ type: "text", text: `${id} result` }], isError, timestamp: 1
  });
  const priorAssistant = assistant("toolUse", [{
    type: "thinking", thinking: "COMPLETE_REASONING", thinkingSignature: "reasoning_content"
  }, toolCall("prior-complete")]);
  const priorResult = toolResult("prior-complete");
  const user = { role: "user" as const, content: "Continue", timestamp: 2 };
  const execution = (context: Context, selectedModel = model) => ({
    runId: "length-run", conversationId: "length-conversation",
    turnId: "length-turn", correlationId: "length-correlation",
    provider: {
      providerId: selectedModel.provider, apiProtocol: "openai-completions" as const,
      authMode: "api-key" as const, baseUrl: selectedModel.baseUrl,
      modelRef: selectedModel.id
    },
    model: selectedModel, context,
    options: { maxTokens: 64, temperature: 0, cacheRetention: "none" as const, maxRetries: 0 as const, timeoutMs: 1_000 }
  });
  const sseEvent = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: "length-response", model: model.id, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const lengthBody = sseEvent({ reasoning_content: "LENGTH_REASONING" })
    + sseEvent({ content: "保留已经生成的正文" })
    + sseEvent({ tool_calls: [{ index: 0, id: "length-complete-json", type: "function", function: { name: "note_read", arguments: "{}" } }] })
    + sseEvent({ tool_calls: [{ index: 1, id: "length-partial-json", type: "function", function: { name: "note_read", arguments: '{"path":' } }] }, "length")
    + "data: [DONE]\n\n";
  const failures: unknown[] = [];
  const check = async (name: string, test: () => void | Promise<void>) => {
    try {
      await test();
      console.log(`PASS output limit: ${name}`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL output limit: ${name}`, error);
    }
  };
  for (const kind of ["qwen", "loopback"] as const) {
    await check(`${kind} returns length with body and no executable calls`, async () => {
      let requests = 0;
      const respond = async () => {
        requests += 1;
        return { status: 200, headers: { "content-type": "text/event-stream" }, body: lengthBody };
      };
      const adapter = kind === "qwen"
        ? createQwenTokenPlanOpenAICompletionsAdapter(respond)
        : createLoopbackOpenAICompletionsAdapter(respond);
      const selectedModel = {
        ...model, provider: kind === "qwen" ? "qwen-token-plan-cn" : model.provider,
        baseUrl: kind === "qwen" ? QWEN_TOKEN_PLAN_API_BASE_URL : "http://127.0.0.1:11434/v1"
      };
      const output = await adapter.stream(selectedModel, { messages: [user] }, { apiKey: "fixture-key", maxTokens: 64 }).result();
      assert.equal(output.stopReason, "length");
      assert.equal(output.errorMessage, undefined);
      assert.deepEqual(output.content.map(block => block.type), ["thinking", "text"]);
      assert.deepEqual(output.content[1], { type: "text", text: "保留已经生成的正文" });
      assert.equal(requests, 1, "the adapter never continues a truncated response itself");
    });
  }
  await check("history keeps partial body, discards truncated reasoning/calls/results and preserves complete signatures", () => {
    const truncated = assistant("length", [{
      type: "thinking", thinking: "LENGTH_REASONING", thinkingSignature: "reasoning_content"
    }, {
      type: "text", text: "LENGTH_BODY", textSignature: "incomplete-item"
    }, toolCall("length-complete-json"), toolCall("length-partial-json")]);
    const messages = [priorAssistant, priorResult, truncated,
      toolResult("length-complete-json", true), toolResult("length-partial-json", true), user];
    const snapshot = structuredClone(messages);
    for (const selectedModel of [model, { ...model, id: "other-model" }]) {
      const history = validProviderHistory(messages, selectedModel);
      assert.equal(history.length, 4);
      assert.deepEqual(history[1], priorResult);
      assert.deepEqual(history[2], { ...truncated, content: [{ type: "text", text: "LENGTH_BODY" }] });
      assert.doesNotMatch(JSON.stringify(history), /LENGTH_REASONING|length-complete-json|length-partial-json|incomplete-item|No result provided/u);
      if (selectedModel === model) assert.deepEqual(history[0], priorAssistant);
    }
    assert.deepEqual(messages, snapshot, "history projection does not mutate the stored transcript");
    const reasoningOnly = validProviderHistory([
      assistant("length", [{ type: "thinking", thinking: "LENGTH_REASONING" }, toolCall("unanswered-length")]), user
    ], model);
    assert.deepEqual(reasoningOnly, [user], "a thinking-only truncation must not become an empty assistant or synthetic tool result");
  });
  await check("native OpenAI SDK through transport leaves continuation to runtime", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let executions = 0;
    let toolEvents = 0;
    const payloads: Record<string, any>[] = [];
    globalThis.fetch = async (_input, init) => {
      requests += 1;
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(requests === 1 ? lengthBody : sseEvent({ content: "UNEXPECTED_INTERNAL_CONTINUATION" }, "stop") + "data: [DONE]\n\n", {
        status: 200, headers: { "content-type": "text/event-stream" }
      });
    };
    try {
      const transport = new PiProviderProtocolTransport({
        authorityId: "length-authority", storeSetId: "length-store", resolveAuthToken: () => "fixture-key"
      });
      const messages = await runAgentLoop([user], {
        systemPrompt: "Test output limit", messages: [priorAssistant, priorResult],
        tools: [{
          name: "note_read", label: "Read note", description: "Fixture tool",
          parameters: { type: "object", properties: {} } as never,
          execute: async () => { executions += 1; return { content: [], details: {} }; }
        }]
      }, {
        model, convertToLlm: messages => messages as Context["messages"], maxRetries: 0
      }, event => { if (event.type === "tool_execution_start") toolEvents += 1; }, undefined,
      (selectedModel, context) => transport.stream(execution(context, selectedModel)));
      assert.equal(requests, 1, "Pi must stop before its internal truncated-tool recovery request");
      assert.equal(executions, 0);
      assert.equal(toolEvents, 0, "no synthetic failed tool receipts are created for discarded calls");
      const result = messages.at(-1);
      assert.equal(result?.role, "assistant");
      if (result?.role !== "assistant") throw new Error("assistant missing");
      assert.equal(result.stopReason, "length");
      assert.deepEqual(result.content.map(block => block.type), ["thinking", "text"]);
      assert.equal(payloads[0]?.messages.find((message: Record<string, any>) => message.role === "assistant")?.reasoning_content, "COMPLETE_REASONING", "same-model DeepSeek reasoning signature remains replayable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  await check("legacy output-limit error becomes a normal length terminal", async () => {
    const message = { ...assistant("error", [{ type: "text", text: "LEGACY_BODY" }, toolCall("legacy-partial")]), errorMessage: "provider_output_limit_reached" };
    const run = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: message });
      return stream;
    };
    const transport = new PiProviderProtocolTransport({
      authorityId: "legacy-length-authority", storeSetId: "legacy-length-store", resolveAuthToken: () => "fixture-key",
      dispatcher: new PiProviderProtocolDispatcher({ "openai-completions": { stream: run, streamSimple: run } })
    });
    const result = await (await transport.stream(execution({ messages: [user] }))).result();
    assert.equal(result.stopReason, "length");
    assert.equal(result.errorMessage, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "LEGACY_BODY" }]);
    assert.equal(message.content.length, 2, "normalization does not mutate the provider message");
  });
  if (failures.length) throw new AggregateError(failures, "Provider output-limit contract failed");
}

async function assertQwenTokenPlanTransportContract(): Promise<void> {
  const transportInput = {
    providerId: "qwen-token-plan" as const,
    runtimeProviderId: "qwen-token-plan-cn",
    apiProtocol: "openai-completions" as const,
    baseUrl:
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
  };
  assert.equal(
    resolveConfiguredPiProviderTransportKind(transportInput),
    "qwen-token-plan"
  );
  assert.equal(resolveConfiguredPiProviderTransportKind({
    ...transportInput,
    providerId: "qwen",
    runtimeProviderId: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  }), "default");
  assert.equal(resolveConfiguredPiProviderTransportKind({
    ...transportInput,
    providerId: "ollama",
    runtimeProviderId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1"
  }), "loopback");

  const completionSse = (content: string): string => [
    `data: ${JSON.stringify({
      id: "fixture-qwen-response",
      model: "qwen3.7-plus",
      choices: [{
        delta: { content },
        finish_reason: "stop"
      }]
    })}`,
    "data: [DONE]",
    ""
  ].join("\n\n");
  const captured: QwenTokenPlanProviderRequest[] = [];
  const qwenAdapter = createQwenTokenPlanOpenAICompletionsAdapter(
    async (request) => {
      captured.push(request);
      return {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        body: completionSse("OK")
      };
    }
  );
  const selected = createConfiguredPiProviderProtocolDispatcher(
    transportInput,
    { qwenTokenPlan: qwenAdapter }
  );
  assert.equal(
    selected.adapters["openai-completions"],
    qwenAdapter,
    "settings preflight, text generation and runtime must share the Token Plan adapter selector"
  );

  const fixtureKey = "fixture-qwen-token-plan-key";
  const draft: PiProviderConfigurationDraft = {
    providerSettingsId: "fixture-qwen-token-plan",
    providerId: "qwen-token-plan",
    runtimeProviderId: "qwen-token-plan-cn",
    apiProtocol: "openai-completions",
    authMode: "api-key",
    baseUrl: transportInput.baseUrl,
    modelId: "qwen3.7-plus",
    apiKey: fixtureKey,
    toolCalling: true,
    imageInput: true,
    reasoning: true,
    contextWindow: 1_000_000,
    modelMaxTokens: 65_536,
    maxOutputTokens: 8_192
  };
  const host = { settings: structuredClone(DEFAULT_SETTINGS) };
  const service = new PiProviderConfigurationService(host, {
    adapters: { "openai-completions": qwenAdapter }
  });
  assert.deepEqual(await service.testConnection(draft), {
    status: "available"
  });
  assert.equal(await service.generateText({
    draft,
    systemPrompt: "Translate.",
    userPrompt: "只回复 OK",
    timeoutMs: 1_000,
    maxTokens: 64
  }), "OK");
  assert.equal(captured.length, 2);
  for (const request of captured) {
    assert.equal(
      request.url,
      `${transportInput.baseUrl}/chat/completions`
    );
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    const payload = JSON.parse(request.body) as Record<string, unknown>;
    assert.equal(payload.model, "qwen3.7-plus");
    assert.equal(payload.stream, true);
    assert.equal(typeof payload.max_tokens, "number");
  }

  let featureRequest: QwenTokenPlanProviderRequest | null = null;
  const featureAdapter = createQwenTokenPlanOpenAICompletionsAdapter(
    async (request) => {
      featureRequest = request;
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          `data: ${JSON.stringify({
            id: "fixture-qwen-feature-response",
            model: "qwen3.7-plus",
            choices: [{
              delta: { reasoning_content: "先检查图片。" },
              finish_reason: null
            }]
          })}`,
          `data: ${JSON.stringify({
            id: "fixture-qwen-feature-response",
            model: "qwen3.7-plus",
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "fixture-tool-call",
                  function: {
                    name: "note_read",
                    arguments: "{\"path\":\"Inbox/test.md\"}"
                  }
                }]
              },
              finish_reason: "tool_calls"
            }]
          })}`,
          "data: [DONE]",
          ""
        ].join("\n\n")
      };
    }
  );
  const featureDispatcher = new PiProviderProtocolDispatcher({
    "openai-completions": featureAdapter
  });
  const qwenCatalogModel = resolveEchoInkPiCatalogModel(
    "qwen-token-plan-cn",
    "qwen3.7-plus"
  );
  assert.ok(qwenCatalogModel);
  const streamingHeaders = {
    "content-type": "text/event-stream; charset=utf-8"
  } as const;
  const runQwenBody = async (
    body: string,
    transportComplete = true
  ): Promise<AssistantMessage> => await createQwenTokenPlanOpenAICompletionsAdapter(
    async () => ({
      status: 200,
      headers: streamingHeaders,
      body,
      transportComplete
    })
  ).stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: [{
      role: "user",
      content: "测试 SSE 收尾",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: fixtureKey,
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 0,
    timeoutMs: 1_000
  }).result();
  const completionEvent = (
    content: string,
    finishReason: string | null
  ): string => `data: ${JSON.stringify({
    id: "fixture-clean-eof-response",
    model: "qwen3.7-plus",
    choices: [{
      delta: { content },
      finish_reason: finishReason
    }]
  })}`;
  const toolCompletionEvent = (finishReason: string): string =>
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "fixture-clean-eof-tool",
            function: {
              name: "note_read",
              arguments: "{\"path\":\"Inbox/clean-eof.md\"}"
            }
          }]
        },
        finish_reason: finishReason
      }]
    })}`;

  const unterminatedFinalJson = await runQwenBody(
    completionEvent("末块完成", "stop")
  );
  assert.equal(unterminatedFinalJson.stopReason, "stop");
  assert.equal(
    unterminatedFinalJson.content[0]?.type === "text"
      ? unterminatedFinalJson.content[0].text
      : "",
    "末块完成"
  );

  const unterminatedDone = await runQwenBody([
    completionEvent("DONE 完成", "stop"),
    "data: [DONE]"
  ].join("\n\n"));
  assert.equal(unterminatedDone.stopReason, "stop");

  const finishReasonWithoutDone = await runQwenBody(
    `${completionEvent("无需 DONE", "stop")}\n\n`
  );
  assert.equal(finishReasonWithoutDone.stopReason, "stop");

  const lengthWithoutDone = await runQwenBody(
    completionEvent("达到长度", "length")
  );
  assert.equal(lengthWithoutDone.stopReason, "length");
  assert.equal(lengthWithoutDone.errorMessage, undefined);
  assert.deepEqual(lengthWithoutDone.content, [{ type: "text", text: "达到长度" }]);

  const toolWithoutDone = await runQwenBody(
    toolCompletionEvent("tool_calls")
  );
  assert.equal(toolWithoutDone.stopReason, "toolUse");
  assert.deepEqual(toolWithoutDone.content[0], {
    type: "toolCall",
    id: "fixture-clean-eof-tool",
    name: "note_read",
    arguments: { path: "Inbox/clean-eof.md" }
  });

  const lengthAfterToolCall = await runQwenBody(
    toolCompletionEvent("length")
  );
  assert.equal(lengthAfterToolCall.stopReason, "length");
  assert.equal(lengthAfterToolCall.errorMessage, undefined);
  assert.deepEqual(lengthAfterToolCall.content, []);

  const filteredAfterToolCall = await runQwenBody(
    toolCompletionEvent("content_filter")
  );
  assert.equal(filteredAfterToolCall.stopReason, "error");
  assert.equal(
    filteredAfterToolCall.errorMessage,
    "provider_content_filtered"
  );
  assert.equal(filteredAfterToolCall.content[0]?.type, "toolCall");

  const callbackCleanEof = await createQwenTokenPlanOpenAICompletionsAdapter(
    async (request) => {
      await request.onResponse?.({ status: 200, headers: streamingHeaders });
      request.onChunk?.(Buffer.from(
        completionEvent("回调末块完成", "stop"),
        "utf8"
      ));
      return {
        status: 200,
        headers: streamingHeaders,
        body: "",
        transportComplete: true
      };
    }
  ).stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: [{
      role: "user",
      content: "测试回调 clean EOF",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: fixtureKey,
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 0,
    timeoutMs: 1_000
  }).result();
  assert.equal(callbackCleanEof.stopReason, "stop");
  assert.equal(
    callbackCleanEof.content[0]?.type === "text"
      ? callbackCleanEof.content[0].text
      : "",
    "回调末块完成"
  );

  const malformedFinalEvent = await runQwenBody("data: []");
  assert.equal(malformedFinalEvent.stopReason, "error");
  assert.equal(malformedFinalEvent.errorMessage, "provider_sse_json_invalid");

  const truncatedFinalEvent = await runQwenBody([
    `${completionEvent("保留截断前内容", null)}\n`,
    "data: {\"choices\":["
  ].join("\n"));
  assert.equal(truncatedFinalEvent.stopReason, "error");
  assert.equal(truncatedFinalEvent.errorMessage, "provider_sse_json_invalid");
  assert.equal(
    truncatedFinalEvent.content[0]?.type === "text"
      ? truncatedFinalEvent.content[0].text
      : "",
    "保留截断前内容"
  );

  const unsupportedFinishReason = await runQwenBody(
    completionEvent("不支持的结束原因", "fixture_unknown")
  );
  assert.equal(unsupportedFinishReason.stopReason, "error");
  assert.equal(
    unsupportedFinishReason.errorMessage,
    "provider_finish_reason_unsupported"
  );

  const filteredCompletion = await runQwenBody(
    completionEvent("过滤前内容", "content_filter")
  );
  assert.equal(filteredCompletion.stopReason, "error");
  assert.equal(
    filteredCompletion.errorMessage,
    "provider_content_filtered"
  );

  let incompleteTransportCalls = 0;
  const incompleteTransport = await createQwenTokenPlanOpenAICompletionsAdapter(
    async () => {
      incompleteTransportCalls += 1;
      return {
        status: 200,
        headers: streamingHeaders,
        body: `${completionEvent("保留不完整传输", "stop")}\n\n`,
        transportComplete: false
      };
    }
  ).stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: [{
      role: "user",
      content: "测试不完整传输",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: fixtureKey,
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 3,
    timeoutMs: 1_000
  }).result();
  assert.equal(incompleteTransportCalls, 1);
  assert.equal(incompleteTransport.stopReason, "error");
  assert.equal(
    incompleteTransport.errorMessage,
    "provider_partial_interrupted_network"
  );
  assert.equal(
    incompleteTransport.content[0]?.type === "text"
      ? incompleteTransport.content[0].text
      : "",
    "保留不完整传输"
  );

  let abortedTransportCalls = 0;
  const abortedTransport = await createQwenTokenPlanOpenAICompletionsAdapter(
    async (request) => {
      abortedTransportCalls += 1;
      await request.onResponse?.({ status: 200, headers: streamingHeaders });
      request.onChunk?.(Buffer.from(
        `${completionEvent("保留中止前内容", null)}\n\n`,
        "utf8"
      ));
      throw new Error("qwen_token_plan_response_aborted");
    }
  ).stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: [{
      role: "user",
      content: "测试中止传输",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: fixtureKey,
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 3,
    timeoutMs: 1_000
  }).result();
  assert.equal(abortedTransportCalls, 1);
  assert.equal(abortedTransport.stopReason, "error");
  assert.equal(
    abortedTransport.errorMessage,
    "provider_partial_interrupted_network"
  );
  assert.equal(
    abortedTransport.content[0]?.type === "text"
      ? abortedTransport.content[0].text
      : "",
    "保留中止前内容"
  );

  const firstReasoningBlock = [
    `data: ${JSON.stringify({
      id: "fixture-incremental-response",
      model: "qwen3.7-plus",
      choices: [{
        delta: { reasoning_content: "推" },
        finish_reason: null
      }]
    })}`,
    ""
  ].join("\n\n");
  const remainingBlocks = [
    `data: ${JSON.stringify({
      id: "fixture-incremental-response",
      model: "qwen3.7-plus",
      choices: [{
        delta: { reasoning_content: "理" },
        finish_reason: null
      }]
    })}`,
    `data: ${JSON.stringify({
      id: "fixture-incremental-response",
      model: "qwen3.7-plus",
      choices: [{ delta: { content: "答" }, finish_reason: null }]
    })}`,
    `data: ${JSON.stringify({
      id: "fixture-incremental-response",
      model: "qwen3.7-plus",
      choices: [{ delta: { content: "案" }, finish_reason: "stop" }]
    })}`,
    `data: ${JSON.stringify({
      usage: {
        prompt_tokens: 4,
        completion_tokens: 4,
        total_tokens: 8
      },
      choices: []
    })}`,
    "data: [DONE]",
    ""
  ].join("\n\n");
  let releaseIncrementalRequest: (() => void) | undefined;
  const incrementalRequestGate = new Promise<void>((resolve) => {
    releaseIncrementalRequest = resolve;
  });
  let incrementalRequestSettled = false;
  const incrementalAdapter = createQwenTokenPlanOpenAICompletionsAdapter(
    async (request) => {
      await request.onResponse?.({ status: 200, headers: streamingHeaders });
      const prefix = Buffer.from(firstReasoningBlock, "utf8");
      const multibyteStart = prefix.indexOf(Buffer.from("推", "utf8"));
      assert.ok(multibyteStart >= 0);
      request.onChunk?.(prefix.subarray(0, multibyteStart + 1));
      request.onChunk?.(prefix.subarray(multibyteStart + 1));
      await incrementalRequestGate;
      const rest = Buffer.from(remainingBlocks, "utf8");
      for (let offset = 0; offset < rest.length; offset += 7) {
        request.onChunk?.(rest.subarray(offset, offset + 7));
      }
      incrementalRequestSettled = true;
      return { status: 200, headers: streamingHeaders, body: "" };
    }
  );
  const incrementalStream = incrementalAdapter.stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: [{
      role: "user",
      content: "请增量回答",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: fixtureKey,
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 0,
    timeoutMs: 1_000
  });
  const incrementalIterator = incrementalStream[Symbol.asyncIterator]();
  const incrementalEvents: AssistantMessageEvent[] = [];
  while (true) {
    const next = await incrementalIterator.next();
    assert.equal(next.done, false);
    incrementalEvents.push(next.value);
    if (next.value.type === "thinking_delta") break;
  }
  assert.equal(
    incrementalRequestSettled,
    false,
    "reasoning delta must be observable before the request finishes"
  );
  releaseIncrementalRequest?.();
  while (true) {
    const next = await incrementalIterator.next();
    if (next.done) break;
    incrementalEvents.push(next.value);
    if (next.value.type === "done" || next.value.type === "error") break;
  }
  const incrementalMessage = await incrementalStream.result();
  assert.equal(incrementalRequestSettled, true);
  assert.deepEqual(
    incrementalEvents
      .filter((event) => event.type === "thinking_delta")
      .map((event) => event.type === "thinking_delta" ? event.delta : ""),
    ["推", "理"]
  );
  assert.deepEqual(
    incrementalEvents
      .filter((event) => event.type === "text_delta")
      .map((event) => event.type === "text_delta" ? event.delta : ""),
    ["答", "案"]
  );
  assert.ok(
    incrementalEvents.findIndex((event) => event.type === "thinking_end")
      < incrementalEvents.findIndex((event) => event.type === "text_start")
  );
  assert.deepEqual(
    incrementalMessage.content.map((entry) => entry.type),
    ["thinking", "text"]
  );
  assert.equal(incrementalMessage.content[0]?.type === "thinking"
    ? incrementalMessage.content[0].thinking
    : "", "推理");
  assert.equal(incrementalMessage.content[1]?.type === "text"
    ? incrementalMessage.content[1].text
    : "", "答案");
  assert.equal(incrementalMessage.usage.totalTokens, 8);

  const interleavedAdapter = createQwenTokenPlanOpenAICompletionsAdapter(
    async () => ({
      status: 200,
      headers: streamingHeaders,
      body: [
        `data: ${JSON.stringify({
          choices: [{
            delta: { reasoning_content: "先查" },
            finish_reason: null
          }]
        })}`,
        `data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "fixture-interleaved-tool",
                function: {
                  name: "note_read",
                  arguments: "{\"path\":\"Inbox/test.md\"}"
                }
              }]
            },
            finish_reason: null
          }]
        })}`,
        `data: ${JSON.stringify({
          choices: [{
            delta: { reasoning_content: "再答" },
            finish_reason: null
          }]
        })}`,
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "完成" }, finish_reason: "stop" }]
        })}`,
        "data: [DONE]",
        ""
      ].join("\n\n")
    })
  );
  const interleavedStream = interleavedAdapter.stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: [{
      role: "user",
      content: "先查再答",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: fixtureKey,
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 0,
    timeoutMs: 1_000
  });
  const interleavedEvents: AssistantMessageEvent[] = [];
  for await (const event of interleavedStream) {
    interleavedEvents.push(event);
  }
  const interleavedMessage = await interleavedStream.result();
  assert.deepEqual(
    interleavedMessage.content.map((entry) => entry.type),
    ["thinking", "thinking", "text"]
  );
  assert.deepEqual(
    interleavedEvents
      .filter((event) => /_(?:start|end)$/u.test(event.type))
      .map((event) => event.type),
    [
      "thinking_start",
      "thinking_end",
      "toolcall_start",
      "toolcall_end",
      "thinking_start",
      "thinking_end",
      "text_start",
      "text_end"
    ]
  );

  let loopbackChunkCount = 0;
  const loopbackAdapter = createLoopbackOpenAICompletionsAdapter(
    async (request: LoopbackProviderRequest) => {
      await request.onResponse?.({ status: 200, headers: streamingHeaders });
      for (const block of [firstReasoningBlock, remainingBlocks]) {
        loopbackChunkCount += 1;
        request.onChunk?.(Buffer.from(block, "utf8"));
      }
      return { status: 200, headers: streamingHeaders, body: "" };
    }
  );
  const loopbackMessage = await loopbackAdapter.stream({
    ...structuredClone(qwenCatalogModel),
    provider: "ollama",
    id: "fixture-loopback-model",
    baseUrl: "http://127.0.0.1:11434/v1"
  }, {
    messages: [{
      role: "user",
      content: "请增量回答",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: "",
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 0,
    timeoutMs: 1_000
  }).result();
  assert.equal(loopbackChunkCount, 2);
  assert.deepEqual(
    loopbackMessage.content.map((entry) => entry.type),
    ["thinking", "text"]
  );

  const featureMessage = await featureDispatcher.stream({
    model: {
      ...structuredClone(qwenCatalogModel),
      baseUrl: transportInput.baseUrl
    },
    context: {
      systemPrompt: "Inspect the supplied note image.",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image", mimeType: "image/png", data: "AA==" }
        ],
        timestamp: Date.now()
      }],
      tools: [{
        name: "note_read",
        description: "Read a note",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }]
    },
    apiKey: fixtureKey,
    options: {
      reasoning: "high",
      maxTokens: 256,
      temperature: 0,
      cacheRetention: "none",
      maxRetries: 0,
      timeoutMs: 1_000
    }
  }).result();
  assert.ok(featureRequest);
  const featurePayload = JSON.parse(
    featureRequest.body
  ) as Record<string, any>;
  assert.equal(featurePayload.enable_thinking, true);
  assert.equal(featurePayload.reasoning_effort, "high");
  assert.equal(featurePayload.max_tokens, 256);
  assert.equal(featurePayload.tools[0].function.name, "note_read");
  assert.deepEqual(featurePayload.messages[1].content, [
    { type: "text", text: "看看这张图" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AA==" }
    }
  ]);
  assert.deepEqual(
    featureMessage.content.map((entry) => entry.type),
    ["thinking", "toolCall"]
  );
  assert.deepEqual(featureMessage.content[1], {
    type: "toolCall",
    id: "fixture-tool-call",
    name: "note_read",
    arguments: { path: "Inbox/test.md" }
  });

  let historyPayload: Record<string, any> | null = null;
  const historyAdapter = createQwenTokenPlanOpenAICompletionsAdapter(
    async (request) => {
      historyPayload = JSON.parse(request.body) as Record<string, any>;
      return {
        status: 200,
        headers: streamingHeaders,
        body: completionSse("历史已清理")
      };
    }
  );
  const assistantHistoryMessage = (
    stopReason: AssistantMessage["stopReason"],
    content: AssistantMessage["content"],
    timestamp: number,
    errorMessage?: string
  ): AssistantMessage => ({
    role: "assistant",
    content,
    api: qwenCatalogModel.api,
    provider: qwenCatalogModel.provider,
    model: qwenCatalogModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp
  });
  const historyMessages: Context["messages"] = [{
    role: "user",
    content: "保留用户历史",
    timestamp: 1
  }, assistantHistoryMessage("error", [{
    type: "text",
    text: "FAILED_ASSISTANT_CANARY"
  }, {
    type: "toolCall",
    id: "failed-tool-call",
    name: "note_read",
    arguments: { path: "FAILED_TOOL_PATH_CANARY" }
  }], 2, "provider_partial_interrupted_network"), {
    role: "toolResult",
    toolCallId: "failed-tool-call",
    toolName: "note_read",
    content: [{ type: "text", text: "FAILED_TOOL_RESULT_CANARY" }],
    isError: false,
    timestamp: 3
  }, assistantHistoryMessage("aborted", [{
    type: "text",
    text: "ABORTED_ASSISTANT_CANARY"
  }], 3.5), assistantHistoryMessage("length", [{
    type: "text",
    text: "LENGTH_ASSISTANT_CANARY"
  }, {
    type: "toolCall",
    id: "length-tool-call",
    name: "note_read",
    arguments: { path: "LENGTH_TOOL_PATH_CANARY" }
  }], 4), {
    role: "toolResult",
    toolCallId: "length-tool-call",
    toolName: "note_read",
    content: [{ type: "text", text: "LENGTH_TOOL_RESULT_CANARY" }],
    isError: false,
    timestamp: 5
  }, assistantHistoryMessage("toolUse", [{
    type: "toolCall",
    id: "valid-tool-call",
    name: "note_read",
    arguments: { path: "VALID_TOOL_PATH_CANARY" }
  }], 6), {
    role: "toolResult",
    toolCallId: "valid-tool-call",
    toolName: "note_read",
    content: [{ type: "text", text: "VALID_TOOL_RESULT_CANARY" }],
    isError: false,
    timestamp: 7
  }, {
    role: "toolResult",
    toolCallId: "orphan-tool-call",
    toolName: "note_read",
    content: [{ type: "text", text: "ORPHAN_TOOL_RESULT_CANARY" }],
    isError: false,
    timestamp: 8
  }, assistantHistoryMessage("toolUse", [{
    type: "toolCall",
    id: "synthetic-tool-call",
    name: "note_read",
    arguments: { path: "SYNTHETIC_TOOL_PATH_CANARY" }
  }], 9), {
    role: "user",
    content: "当前问题",
    timestamp: 10
  }];
  await historyAdapter.stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: historyMessages,
    tools: []
  }, {
    apiKey: fixtureKey,
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 0,
    timeoutMs: 1_000
  }).result();
  assert.ok(historyPayload);
  const projectedHistory = JSON.stringify(historyPayload.messages);
  assert.doesNotMatch(
    projectedHistory,
    /FAILED_|ABORTED_|LENGTH_TOOL_|ORPHAN_/u,
    "failed, aborted, truncated Tool history and orphaned Tool results must not reach Provider payloads"
  );
  assert.match(projectedHistory, /LENGTH_ASSISTANT_CANARY/u);
  assert.match(projectedHistory, /VALID_TOOL_(?:PATH|RESULT)_CANARY/u);
  assert.match(projectedHistory, /SYNTHETIC_TOOL_PATH_CANARY/u);
  assert.match(projectedHistory, /No result provided/u);
  assert.deepEqual(
    historyPayload.messages.map((message: { role: string }) => message.role),
    ["user", "assistant", "assistant", "tool", "assistant", "tool", "user"]
  );

  const reasoningPayloads: Record<string, any>[] = [];
  const reasoningDispatcher = new PiProviderProtocolDispatcher({
    "openai-completions": createQwenTokenPlanOpenAICompletionsAdapter(
      async (request) => {
        reasoningPayloads.push(JSON.parse(request.body));
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: completionSse("OK")
        };
      }
    )
  });
  const captureReasoningPayload = async (
    modelId: string,
    reasoning?: ModelThinkingLevel
  ): Promise<Record<string, any>> => {
    const model = resolveEchoInkPiCatalogModel(
      "qwen-token-plan-cn",
      modelId
    );
    assert.ok(model);
    await reasoningDispatcher.stream({
      model: { ...structuredClone(model), baseUrl: transportInput.baseUrl },
      context: {
        messages: [{
          role: "user",
          content: "只回复 OK",
          timestamp: Date.now()
        }],
        tools: []
      },
      apiKey: fixtureKey,
      options: {
        ...(reasoning ? { reasoning } : {}),
        maxTokens: 64,
        temperature: 0,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs: 1_000
      }
    }).result();
    return reasoningPayloads.at(-1) ?? {};
  };
  const qwenOff = await captureReasoningPayload("qwen3.7-plus", "off");
  assert.equal(qwenOff.enable_thinking, false);
  assert.equal(Object.hasOwn(qwenOff, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(qwenOff, "thinking_budget"), false);
  for (const reasoning of [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ] as const) {
    const payload = await captureReasoningPayload(
      "qwen3.7-plus",
      reasoning
    );
    assert.equal(payload.enable_thinking, true);
    assert.equal(payload.reasoning_effort, reasoning);
    assert.equal(Object.hasOwn(payload, "thinking_budget"), false);
  }
  for (const reasoning of ["low", "medium", "xhigh"] as const) {
    const payload = await captureReasoningPayload(
      "qwen3.8-max-preview",
      reasoning
    );
    assert.equal(payload.enable_thinking, true);
    assert.equal(payload.reasoning_effort, reasoning);
    assert.equal(Object.hasOwn(payload, "thinking_budget"), false);
  }
  const deepSeekHigh = await captureReasoningPayload(
    "deepseek-v4-pro",
    "high"
  );
  assert.deepEqual(deepSeekHigh.thinking, { type: "enabled" });
  assert.equal(deepSeekHigh.reasoning_effort, "high");
  assert.equal(Object.hasOwn(deepSeekHigh, "enable_thinking"), false);
  const deepSeekMax = await captureReasoningPayload(
    "deepseek-v4-pro",
    "max"
  );
  assert.deepEqual(deepSeekMax.thinking, { type: "enabled" });
  assert.equal(deepSeekMax.reasoning_effort, "max");
  const deepSeekOff = await captureReasoningPayload(
    "deepseek-v4-pro",
    "off"
  );
  assert.deepEqual(deepSeekOff.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(deepSeekOff, "reasoning_effort"), false);

  const manualQwenModel = createPiNativeModelFromConfiguration({
    catalogModel: undefined,
    provider: {
      providerId: "qwen-token-plan-cn",
      apiProtocol: "openai-completions",
      authMode: "api-key",
      baseUrl: transportInput.baseUrl,
      modelRef: "qwen3.8-max"
    },
    configured: {
      apiProtocol: "openai-completions",
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      reasoning: true,
      imageInput: true
    }
  });
  for (const reasoning of [
    "low",
    "medium",
    "xhigh"
  ] as const) {
    await reasoningDispatcher.stream({
      model: manualQwenModel,
      context: {
        messages: [{
          role: "user",
          content: "只回复 OK",
          timestamp: Date.now()
        }],
        tools: []
      },
      apiKey: fixtureKey,
      options: {
        reasoning,
        maxTokens: 64,
        temperature: 0,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs: 1_000
      }
    }).result();
    const payload = reasoningPayloads.at(-1) ?? {};
    assert.equal(payload.reasoning_effort, reasoning);
    assert.equal(payload.enable_thinking, true);
    assert.equal(Object.hasOwn(payload, "thinking_budget"), false);
    assert.equal(Object.hasOwn(payload, "thinking"), false);
  }

  const failureCases: Array<{
    status: number;
    failure: Extract<
      PiProviderConnectionTestResult,
      { status: "failed" }
    >["failure"];
  }> = [
    { status: 401, failure: "auth" },
    { status: 400, failure: "protocol" },
    { status: 429, failure: "rate_limit" },
    { status: 503, failure: "provider" }
  ];
  for (const entry of failureCases) {
    const adapter = createQwenTokenPlanOpenAICompletionsAdapter(async () => ({
      status: entry.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message: "fixture failure" } })
    }));
    const result = await testProviderConnection({
      draft,
      apiKey: fixtureKey,
      dispatcher: new PiProviderProtocolDispatcher({
        "openai-completions": adapter
      })
    });
    assert.deepEqual(result, { status: "failed", failure: entry.failure, detail: { status: entry.status } });
    assert.equal(JSON.stringify(result).includes(fixtureKey), false);
  }
  const overflowTransport = new PiProviderProtocolTransport({
    authorityId: "fixture-qwen-overflow-authority",
    storeSetId: "fixture-qwen-overflow-store",
    resolveAuthToken: async () => fixtureKey,
    dispatcher: new PiProviderProtocolDispatcher({
      "openai-completions": createQwenTokenPlanOpenAICompletionsAdapter(
        async () => ({
          status: 400,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            error: {
              message: "Maximum context length exceeded; reduce input tokens."
            }
          })
        })
      )
    })
  });
  const overflowStream = await overflowTransport.stream({
    runId: "fixture-qwen-overflow-run",
    conversationId: "fixture-qwen-overflow-conversation",
    turnId: "fixture-qwen-overflow-turn",
    correlationId: "fixture-qwen-overflow-correlation",
    provider: {
      providerId: "qwen-token-plan-cn",
      apiProtocol: "openai-completions",
      authMode: "api-key",
      baseUrl: transportInput.baseUrl,
      modelRef: "qwen3.7-plus"
    },
    model: {
      ...structuredClone(qwenCatalogModel),
      baseUrl: transportInput.baseUrl
    },
    context: {
      messages: [{
        role: "user",
        content: "fixture oversized context",
        timestamp: Date.now()
      }],
      tools: []
    },
    options: {
      maxTokens: 64,
      temperature: 0,
      cacheRetention: "none",
      maxRetries: 0,
      timeoutMs: 1_000
    }
  });
  const overflow = await overflowStream.result();
  assert.equal(overflow.stopReason, "error");
  assert.equal(overflow.errorMessage, "context_length_exceeded");
  assert.equal(JSON.stringify(overflow).includes(fixtureKey), false);

  const network = await testProviderConnection({
    draft,
    apiKey: fixtureKey,
    dispatcher: new PiProviderProtocolDispatcher({
      "openai-completions": createQwenTokenPlanOpenAICompletionsAdapter(
        async () => {
          throw new Error("Connection error.");
        }
      )
    })
  });
  assert.deepEqual(network, { status: "failed", failure: "network" });
  assert.equal(JSON.stringify(network).includes(fixtureKey), false);

  const malformed = await testProviderConnection({
    draft,
    apiKey: fixtureKey,
    dispatcher: new PiProviderProtocolDispatcher({
      "openai-completions": createQwenTokenPlanOpenAICompletionsAdapter(
        async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{}"
        })
      )
    })
  });
  assert.deepEqual(malformed, { status: "failed", failure: "protocol", detail: { status: 200 } });

  const incomplete = await testProviderConnection({
    draft,
    apiKey: fixtureKey,
    dispatcher: new PiProviderProtocolDispatcher({
      "openai-completions": createQwenTokenPlanOpenAICompletionsAdapter(
        async () => ({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: `data: ${JSON.stringify({
            choices: [{
              delta: { content: "未完成" },
              finish_reason: null
            }]
          })}\n\n`
        })
      )
    })
  });
  assert.deepEqual(incomplete, { status: "failed", failure: "protocol", detail: { status: 200 } });
  const partialFailureStream = createQwenTokenPlanOpenAICompletionsAdapter(
    async () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: `data: ${JSON.stringify({
        choices: [{
          delta: { content: "保留部分回答" },
          finish_reason: null
        }]
      })}\n\n`
    })
  ).stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: [{
      role: "user",
      content: "测试中断",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: fixtureKey,
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 0,
    timeoutMs: 1_000
  });
  const partialFailure = await partialFailureStream.result();
  assert.equal(partialFailure.stopReason, "error");
  assert.equal(
    partialFailure.errorMessage,
    "provider_finish_reason_missing"
  );
  assert.equal(partialFailure.content[0]?.type === "text"
    ? partialFailure.content[0].text
    : "", "保留部分回答");

  const invalidUtf8 = await createQwenTokenPlanOpenAICompletionsAdapter(
    async (request) => {
      await request.onResponse?.({ status: 200, headers: streamingHeaders });
      request.onChunk?.(Uint8Array.from([0xc3, 0x28]));
      return {
        status: 200,
        headers: streamingHeaders,
        body: "",
        transportComplete: true
      };
    }
  ).stream({
    ...structuredClone(qwenCatalogModel),
    baseUrl: transportInput.baseUrl
  }, {
    messages: [{
      role: "user",
      content: "测试非法 UTF-8",
      timestamp: Date.now()
    }],
    tools: []
  }, {
    apiKey: fixtureKey,
    reasoning: "high",
    maxTokens: 64,
    temperature: 0,
    cacheRetention: "none",
    maxRetries: 0,
    timeoutMs: 1_000
  }).result();
  assert.equal(invalidUtf8.stopReason, "error");
  assert.equal(invalidUtf8.errorMessage, "provider_utf8_invalid");

  const oversized = await testProviderConnection({
    draft,
    apiKey: fixtureKey,
    dispatcher: new PiProviderProtocolDispatcher({
      "openai-completions": createQwenTokenPlanOpenAICompletionsAdapter(
        async () => ({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: "x".repeat(16 * 1024 * 1024 + 1)
        })
      )
    })
  });
  assert.deepEqual(oversized, { status: "failed", failure: "protocol", detail: { status: 200 } });

  const timedOut = await testProviderConnection({
    draft,
    apiKey: fixtureKey,
    dispatcher: new PiProviderProtocolDispatcher({
      "openai-completions": createQwenTokenPlanOpenAICompletionsAdapter(
        async (request) => await new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new Error("qwen_token_plan_aborted"));
          }, { once: true });
        })
      )
    }),
    timeoutMs: 5
  });
  assert.deepEqual(timedOut, { status: "failed", failure: "timeout" });
  assert.equal(
    JSON.stringify([malformed, incomplete, oversized, timedOut])
      .includes(fixtureKey),
    false
  );
}

async function assertPiAgentSessionPartialAwareRetryContract(): Promise<void> {
  const productionRetry = SettingsManager.inMemory({ retry: { enabled: true, provider: { maxRetries: 0 } } }).getRetrySettings();
  assert.deepEqual(productionRetry, { enabled: true, maxRetries: 3, baseDelayMs: 2_000 });
  let retryEvents: Array<{ attempt: number; delayMs: number }> = [];
  const baseUrl = QWEN_TOKEN_PLAN_API_BASE_URL;
  const catalogModel = resolveEchoInkPiCatalogModel(
    "qwen-token-plan-cn",
    "qwen3.7-plus"
  );
  assert.ok(catalogModel);
  const provider = {
    providerId: "qwen-token-plan-cn",
    apiProtocol: "openai-completions" as const,
    authMode: "api-key" as const,
    baseUrl,
    modelRef: catalogModel.id
  };
  const model = createPiNativeModelFromConfiguration({
    catalogModel,
    provider,
    configured: {
      apiProtocol: "openai-completions",
      contextWindow: catalogModel.contextWindow,
      maxOutputTokens: catalogModel.maxTokens,
      reasoning: true,
      imageInput: false
    }
  });
  const streamingHeaders = {
    "content-type": "text/event-stream; charset=utf-8"
  } as const;
  const successBody = [
    `data: ${JSON.stringify({
      choices: [{
        delta: { content: "重试后成功" },
        finish_reason: "stop"
      }]
    })}`,
    "data: [DONE]",
    ""
  ].join("\n\n");

  const runSession = async (
    requestImpl: Parameters<
      typeof createQwenTokenPlanOpenAICompletionsAdapter
    >[0]
  ): Promise<AssistantMessage[]> => {
    retryEvents = [];
    const dispatcher = new PiProviderProtocolDispatcher({
      "openai-completions": createQwenTokenPlanOpenAICompletionsAdapter(
        requestImpl
      )
    });
    const controlledStream = new PiProviderProtocolTransport({
      authorityId: "fixture-agent-retry-authority",
      storeSetId: "fixture-agent-retry-store",
      resolveAuthToken: async () => "fixture-agent-retry-key",
      dispatcher
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false
    });
    modelRuntime.registerNativeProvider(createPiNativeControlledProvider({
      config: { read: async () => provider },
      controlledStream,
      model,
      maxTokens: 64,
      currentExecutionContext: () => ({
        runId: "fixture-agent-retry-run",
        conversationId: "fixture-agent-retry-conversation",
        turnId: "fixture-agent-retry-turn",
        correlationId: "fixture-agent-retry-correlation"
      })
    }));
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: model.provider,
      defaultModel: model.id,
      defaultThinkingLevel: "high",
      compaction: { enabled: true },
      retry: {
        enabled: true,
        maxRetries: productionRetry.maxRetries,
        baseDelayMs: 1,
        provider: { maxRetries: 0 }
      },
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: []
    });
    const sessionManager = SessionManager.inMemory(process.cwd());
    const resourceLoader = new ControlledVaultResourceLoader({
      vaultRoot: process.cwd(),
      systemPrompt: "只回复测试结果。"
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      modelRuntime,
      model,
      thinkingLevel: "high",
      noTools: "all",
      sessionManager,
      settingsManager,
      resourceLoader
    });
    const retrySubscription = session.subscribe(event => {
      if (event.type === "auto_retry_start") retryEvents.push({ attempt: event.attempt, delayMs: event.delayMs });
    });
    try {
      await session.prompt("测试 partial-aware retry");
      return sessionManager.getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message)
        .filter((message): message is AssistantMessage =>
          message.role === "assistant"
        );
    } finally {
      retrySubscription();
      session.dispose();
    }
  };

  let partialCalls = 0;
  const partialMessages = await runSession(async (request) => {
    partialCalls += 1;
    await request.onResponse?.({ status: 200, headers: streamingHeaders });
    request.onChunk?.(Buffer.from([
      `data: ${JSON.stringify({
        choices: [{
          delta: { reasoning_content: "公开推理 partial" },
          finish_reason: null
        }]
      })}`,
      `data: ${JSON.stringify({
        choices: [{
          delta: { content: "公开答案 partial" },
          finish_reason: null
        }]
      })}`,
      `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "fixture-partial-tool",
              function: {
                name: "note_read",
                arguments: "{\"path\":"
              }
            }]
          },
          finish_reason: null
        }]
      })}`,
      ""
    ].join("\n\n"), "utf8"));
    throw new Error("qwen_token_plan_response_aborted");
  });
  assert.equal(
    partialCalls,
    1,
    "reasoning, answer or Tool partial must make the first failed attempt terminal"
  );
  assert.equal(
    partialMessages.at(-1)?.errorMessage,
    "provider_partial_interrupted_network"
  );

  let contextPartialCalls = 0;
  const contextPartialMessages = await runSession(async (request) => {
    contextPartialCalls += 1;
    await request.onResponse?.({ status: 200, headers: streamingHeaders });
    request.onChunk?.(Buffer.from(
      `data: ${JSON.stringify({
        choices: [{
          delta: { content: "上下文失败前 partial" },
          finish_reason: null
        }]
      })}\n\n`,
      "utf8"
    ));
    throw new Error("context_length_exceeded");
  });
  assert.equal(
    contextPartialCalls,
    1,
    "a context overflow after partial must not enter Pi compact-and-retry"
  );
  assert.equal(
    contextPartialMessages.at(-1)?.errorMessage,
    "provider_partial_interrupted_context"
  );

  let zeroOutputCalls = 0;
  const zeroOutputMessages = await runSession(async () => {
    zeroOutputCalls += 1;
    if (zeroOutputCalls === 1) throw new Error("Connection error.");
    return {
      status: 200,
      headers: streamingHeaders,
      body: successBody,
      transportComplete: true
    };
  });
  assert.equal(
    zeroOutputCalls,
    2,
    "Pi's existing zero-output transient-network retry must remain available"
  );
  assert.equal(zeroOutputMessages.at(-1)?.stopReason, "stop");

  const failureResponse = (status: number, code: string, message: string) => ({
    status, headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: { code, message } }), transportComplete: true
  });
  let transientCalls = 0;
  const transientMessages = await runSession(async () => {
    const status = [429, 500, 503][transientCalls++];
    if (status) return failureResponse(status, "temporary_failure", status === 429 ? "Too many requests" : "Service unavailable");
    return { status: 200, headers: streamingHeaders, body: successBody, transportComplete: true };
  });
  assert.equal(transientCalls, 4, "only the AgentSession layer retries the three temporary failures");
  assert.equal(transientMessages.at(-1)?.stopReason, "stop");
  assert.deepEqual(retryEvents, [{ attempt: 1, delayMs: 1 }, { attempt: 2, delayMs: 2 }, { attempt: 3, delayMs: 4 }]);
  let exhaustedCalls = 0;
  const exhausted = await runSession(async () => { exhaustedCalls++; return failureResponse(503, "temporary_failure", "Service unavailable"); });
  assert.equal(exhaustedCalls, 4);
  assert.equal(exhausted.at(-1)?.stopReason, "error");
  for (const failure of [
    { status: 401, code: "invalid_api_key", message: "Unauthorized" },
    { status: 429, code: "insufficient_quota", message: "quota exceeded" },
    { status: 404, code: "model_not_found", message: "Model not found" }
  ]) {
    let calls = 0;
    const messages = await runSession(async () => { calls++; return failureResponse(failure.status, failure.code, failure.message); });
    assert.equal(calls, 1, `${failure.code} must fail without retrying`);
    assert.equal(messages.at(-1)?.stopReason, "error");
    assert.deepEqual(retryEvents, []);
  }
  assert.equal(classifyPiProviderConnectionFailure(429, '{"error":{"code":"insufficient_quota"}}'), "request");
  const loopbackModel = { ...model, provider: "ollama", id: "fixture-loopback-retry", baseUrl: "http://127.0.0.1:11434/v1" };
  for (const [code, expected] of [["insufficient_quota", "provider_request_rejected"], ["rate_limit_exceeded", "provider_rate_limited"]]) {
    let calls = 0;
    const adapter = createLoopbackOpenAICompletionsAdapter(async () => {
      calls++; return failureResponse(429, code, code === "insufficient_quota" ? "quota exceeded" : "Too many requests");
    });
    const failure = await adapter.streamSimple(loopbackModel, { messages: [{ role: "user", content: "test", timestamp: 1 }] }, { maxTokens: 64 }).result();
    assert.equal(calls, 1, "the adapter never adds a second retry layer");
    assert.equal(failure.errorMessage, expected);
    assert.equal(isRetryableAssistantError(failure), code !== "insufficient_quota");
  }
  console.log("PASS provider retry: temporary 429/500/503 recover in 4 attempts; exhaustion stops after 4; auth/quota/missing model stop after 1 (test backoff scaled to 1/2/4ms; production 2/4/8s)");

  const classifierMessage = (errorMessage: string): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: "error",
    errorMessage,
    timestamp: 1
  });
  for (const code of [
    "provider_partial_interrupted_context",
    "provider_partial_interrupted_network",
    "provider_partial_interrupted_rate",
    "provider_partial_interrupted_service"
  ]) {
    assert.equal(isRetryableAssistantError(classifierMessage(code)), false);
  }
  for (const code of [
    "provider_network_error",
    "provider_rate_limited",
    "provider_service_unavailable"
  ]) {
    assert.equal(isRetryableAssistantError(classifierMessage(code)), true);
  }
  assert.equal(
    isContextOverflow(
      classifierMessage("provider_partial_interrupted_context"),
      model.contextWindow
    ),
    false
  );
  assert.equal(
    isContextOverflow(
      classifierMessage("context_length_exceeded"),
      model.contextWindow
    ),
    true
  );

  const genericContextStream = () => {
      const output = createAssistantMessageEventStream();
      const error = {
        ...classifierMessage("context_length_exceeded"),
        content: [{ type: "text" as const, text: "generic partial" }]
      };
      output.push({ type: "start", partial: error });
      output.push({ type: "error", reason: "error", error });
      return output;
  };
  const genericContextAdapter: ProviderStreams = {
    stream: genericContextStream,
    streamSimple: genericContextStream
  };
  const genericTransport = new PiProviderProtocolTransport({
    authorityId: "fixture-generic-partial-context-authority",
    storeSetId: "fixture-generic-partial-context-store",
    resolveAuthToken: async () => "fixture-generic-partial-context-key",
    dispatcher: new PiProviderProtocolDispatcher({
      "openai-completions": genericContextAdapter
    })
  });
  const genericContextResult = await (await genericTransport.stream({
    runId: "fixture-generic-partial-context-run",
    conversationId: "fixture-generic-partial-context-conversation",
    turnId: "fixture-generic-partial-context-turn",
    correlationId: "fixture-generic-partial-context-correlation",
    provider,
    model,
    context: {
      messages: [{
        role: "user",
        content: "测试通用 sanitizer",
        timestamp: 1
      }],
      tools: []
    },
    options: {
      maxTokens: 64,
      temperature: 0,
      cacheRetention: "none",
      maxRetries: 0,
      timeoutMs: 1_000
    }
  })).result();
  assert.equal(
    genericContextResult.errorMessage,
    "provider_partial_interrupted_context",
    "the generic Provider sanitizer must close the same compact-and-retry path"
  );
}

async function assertProviderModelDiscoveryRequestContract(): Promise<void> {
  const draft = providerModelDiscoveryDraft("openai-completions");
  const fakeKey = "fixture-model-discovery-key";
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const available = await requestProviderModels({
    draft,
    apiKey: fakeKey,
    fetchImpl: async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return {
        status: 200,
        json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] })
      };
    }
  });
  assert.deepEqual(available, {
    status: "available",
    models: [{ id: "model-a" }, { id: "model-b" }],
    source: "remote"
  });
  assert.equal(requestedUrl, "https://current.example/v1/models");
  assert.equal(requestedInit?.method, "GET");
  assert.deepEqual(requestedInit?.headers, {
    authorization: `Bearer ${fakeKey}`
  });
  assert.equal(requestedInit?.redirect, "error");

  const statuses: Array<{
    status: number;
    expected: PiProviderModelListResult["status"];
  }> = [
    { status: 401, expected: "api_key_error" },
    { status: 404, expected: "unsupported" },
    { status: 429, expected: "rate_or_service_error" },
    { status: 503, expected: "rate_or_service_error" }
  ];
  for (const entry of statuses) {
    const result = await requestProviderModels({
      draft,
      apiKey: fakeKey,
      fetchImpl: async () => ({
        status: entry.status,
        json: async () => ({ data: [] })
      })
    });
    assert.equal(result.status, entry.expected);
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
  }
  const network = await requestProviderModels({
    draft,
    apiKey: fakeKey,
    fetchImpl: async () => {
      throw new Error("fixture-network-failure");
    }
  });
  assert.equal(network.status, "network_error");
  const malformed = await requestProviderModels({
    draft,
    apiKey: fakeKey,
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ models: ["wrong-shape"] })
    })
  });
  assert.equal(malformed.status, "response_format_error");
  assert.equal(JSON.stringify([network, malformed]).includes(fakeKey), false);

  const anthropicDraft = providerModelDiscoveryDraft("anthropic-messages");
  let anthropicRequest: { url: string; init: RequestInit } | undefined;
  await requestProviderModels({
    draft: anthropicDraft,
    apiKey: fakeKey,
    fetchImpl: async (url, init) => {
      anthropicRequest = { url, init };
      return { status: 200, json: async () => ({ data: [] }) };
    }
  });
  assert.equal(anthropicRequest?.url, "https://current.example/v1/models");
  assert.deepEqual(anthropicRequest?.init.headers, {
    "x-api-key": fakeKey,
    "anthropic-version": "2023-06-01"
  });

  let obsidianRequest: Record<string, unknown> | undefined;
  const cloudFetch = createObsidianProviderFetch(async (input) => {
    obsidianRequest = structuredClone(input) as unknown as Record<string, unknown>;
    return {
      status: 200,
      json: { data: [{ id: "obsidian-model" }] }
    } as never;
  });
  const cloudResponse = await cloudFetch(
    "https://cloud.example/v1/models",
    {
      method: "GET",
      headers: { authorization: `Bearer ${fakeKey}` }
    }
  );
  assert.equal(cloudResponse.status, 200);
  assert.deepEqual(await cloudResponse.json(), {
    data: [{ id: "obsidian-model" }]
  });
  assert.deepEqual(obsidianRequest, {
    url: "https://cloud.example/v1/models",
    method: "GET",
    headers: { authorization: `Bearer ${fakeKey}` },
    throw: false
  });

  const localFetch: PiProviderFetch = async () => ({
    status: 200,
    json: async () => ({ data: [] })
  });
  assert.equal(
    providerModelFetchForUrl("https://cloud.example/v1", cloudFetch, localFetch),
    cloudFetch
  );
  assert.equal(
    providerModelFetchForUrl("http://127.0.0.1:11434/v1", cloudFetch, localFetch),
    localFetch
  );
}

function providerModelDiscoveryDraft(
  apiProtocol: "openai-completions" | "anthropic-messages"
): PiProviderConfigurationDraft {
  return {
    providerSettingsId: "model-discovery-provider",
    providerId: "custom",
    runtimeProviderId: "custom",
    apiProtocol,
    authMode: "api-key",
    baseUrl: "https://current.example/v1/",
    modelId: "",
    apiKey: "",
    toolCalling: false,
    imageInput: false,
    reasoning: false,
    contextWindow: 64_000,
    modelMaxTokens: 8_192,
    maxOutputTokens: 8_192
  };
}

function assertCustomProtocolContract(): void {
  for (const protocol of [
    "openai-completions",
    "openai-responses",
    "anthropic-messages"
  ] as const) {
    assert.equal(normalizeApiProviderProtocol(protocol, "custom"), protocol);
  }
  assert.equal(
    normalizeApiProviderProtocol("openai-codex-responses", "custom"),
    "openai-completions"
  );
  assert.equal(
    normalizeApiProviderProtocol("anthropic-messages", "deepseek"),
    "openai-completions"
  );

  const provider = createApiProviderConfig("custom", "custom-protocol-fixture");
  provider.baseUrl = "https://api.example.com/v1";
  provider.apiProtocol = "openai-responses";
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: false,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => ({ status: "available", models: [] }),
      testConnection: async () => ({ status: "ok" })
    },
    save: async () => ({ saved: true })
  });
  modal.open();

  const form = modal.contentEl.querySelector<HTMLElement>(".codex-provider-modal-form");
  const connectionCard = form?.querySelector<HTMLElement>(".provider-connection-card");
  const modelCard = form?.querySelector<HTMLElement>(".provider-model-card");
  assert.ok(form && connectionCard && modelCard);
  const labels = Array.from(
    connectionCard.querySelectorAll<HTMLElement>("[data-provider-field-label]")
  ).map((element) => element.textContent ?? "");
  assert.ok(labels.includes("Endpoint URL") && labels.includes("API protocol") && labels.includes("API Key"));
  assert.ok(labels.indexOf("Endpoint URL") < labels.indexOf("API protocol"));
  assert.ok(labels.indexOf("API protocol") < labels.indexOf("API Key"));
  const cards = Array.from(form.children);
  assert.ok(cards.indexOf(connectionCard) >= 0 && cards.indexOf(connectionCard) < cards.indexOf(modelCard));
  assert.equal(modelCard.querySelector("h3")?.textContent, "Enabled models");
  assert.doesNotMatch(modal.contentEl.textContent, /Custom protocol/u);

  const select = modal.contentEl.querySelector<HTMLSelectElement>(
    '[data-modal-focus-key="protocol"]'
  );
  assert.ok(select);
  assert.equal(select.value, "openai-responses");
  assert.deepEqual(
    Array.from(select.querySelectorAll<HTMLOptionElement>("option"))
      .map((option) => option.value),
    ["openai-completions", "openai-responses", "anthropic-messages"]
  );
  modal.close();
}

function assertOpenAICodexSseAdapterContract(): void {
  const captured: StreamOptions[] = [];
  const upstream: ProviderStreams = {
    stream: (_model, _context, options) => {
      captured.push(options ?? {});
      return {} as never;
    },
    streamSimple: (_model, _context, options) => {
      captured.push(options ?? {});
      return {} as never;
    }
  };
  const adapter = createOpenAICodexSseAdapter(upstream);
  adapter.stream({} as never, {} as never, {
    transport: "websocket"
  });
  adapter.streamSimple({} as never, {} as never, {
    transport: "auto"
  });
  assert.deepEqual(
    captured.map((options) => options.transport),
    ["sse", "sse"]
  );
}

async function assertProviderRequestLimitDispatchContract(): Promise<void> {
  const calls: string[] = [];
  const adapter: ProviderStreams = {
    stream: () => {
      calls.push("stream");
      const output = createAssistantMessageEventStream();
      output.end();
      return output;
    },
    streamSimple: () => {
      calls.push("streamSimple");
      const output = createAssistantMessageEventStream();
      output.end();
      return output;
    }
  };
  const dispatcher = new PiProviderProtocolDispatcher({
    "openai-completions": adapter,
    "openai-responses": adapter,
    "anthropic-messages": adapter
  });
  const transport = new PiProviderProtocolTransport({
    authorityId: "request-limit-dispatch-authority",
    storeSetId: "request-limit-dispatch-store",
    resolveAuthToken: async () => "fixture-key",
    dispatcher
  });
  const dispatch = async (
    apiProtocol: "openai-completions" | "openai-responses" | "anthropic-messages",
    maxTokens?: number
  ): Promise<void> => {
    const model = createPiProviderModelDefinition({
      providerId: "custom",
      apiProtocol,
      baseUrl: "https://fixture.example/v1",
      modelRef: "fixture/model",
      contextWindow: 64_000,
      maxOutputTokens: 8_192
    });
    await transport.stream({
      runId: "request-limit-dispatch-run",
      conversationId: "request-limit-dispatch-conversation",
      turnId: "request-limit-dispatch-turn",
      correlationId: "request-limit-dispatch-correlation",
      provider: {
        providerId: "custom",
        apiProtocol,
        authMode: "api-key",
        baseUrl: "https://fixture.example/v1",
        modelRef: "fixture/model"
      },
      model,
      context: { messages: [], tools: [] },
      options: {
        ...(maxTokens === undefined ? {} : { maxTokens }),
        temperature: 0,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs: 1_000
      }
    });
  };

  await dispatch("openai-completions");
  await dispatch("openai-responses");
  await dispatch("openai-completions", 2_048);
  await dispatch("anthropic-messages", 8_192);
  assert.deepEqual(
    calls,
    ["streamSimple", "streamSimple", "streamSimple", "streamSimple"]
  );
}

async function assertProtocolPayloadLimitContract(): Promise<void> {
  const dispatcher = new PiProviderProtocolDispatcher();
  const context: Context = {
    messages: [{
      role: "user",
      content: "Capture the context-clamped output limit.",
      timestamp: 1
    }],
    tools: []
  };
  const createModel = (
    apiProtocol: "openai-completions" | "openai-responses" | "anthropic-messages"
  ): Model<Api> => createPiProviderModelDefinition({
    providerId: "custom",
    apiProtocol,
    baseUrl: "http://127.0.0.1:1/v1",
    modelRef: "payload-fixture-model",
    contextWindow: 6_000,
    maxOutputTokens: 4_096
  });
  const capture = async (
    model: Model<Api>,
    maxTokens?: number,
    apiKey = "fixture-payload-key"
  ): Promise<Record<string, unknown>> => {
    let payload: Record<string, unknown> | undefined;
    const onPayload = (value: unknown): never => {
      payload = structuredClone(value) as Record<string, unknown>;
      throw new Error("fixture_payload_captured");
    };
    const stream = dispatcher.streamSimple({
      model,
      context,
      apiKey,
      options: {
        temperature: 0,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        maxRetries: 0,
        timeoutMs: 1_000,
        onPayload
      }
    });
    await stream.result();
    assert.ok(payload);
    return payload;
  };

  const chatModel = createModel("openai-completions");
  const expectedMaximum = clampMaxTokensToContext(
    chatModel,
    context,
    chatModel.maxTokens
  );
  assert.ok(expectedMaximum < chatModel.maxTokens);
  const chat = await capture(chatModel);
  assert.equal(chat.max_tokens, expectedMaximum);
  assert.equal(Object.hasOwn(chat, "max_completion_tokens"), false);
  const chatLower = await capture(chatModel, 1_024);
  assert.equal(chatLower.max_tokens, 1_024);

  const completionFieldModel: Model<Api> = {
    ...structuredClone(chatModel),
    compat: {
      ...(structuredClone(chatModel.compat) ?? {}),
      maxTokensField: "max_completion_tokens"
    }
  };
  const completionField = await capture(completionFieldModel);
  assert.equal(completionField.max_completion_tokens, expectedMaximum);
  assert.equal(Object.hasOwn(completionField, "max_tokens"), false);

  const responsesModel = createModel("openai-responses");
  const responses = await capture(responsesModel);
  assert.equal(responses.max_output_tokens, expectedMaximum);
  const responsesLower = await capture(responsesModel, 1_024);
  assert.equal(responsesLower.max_output_tokens, 1_024);

  const anthropicModel = createModel("anthropic-messages");
  const anthropic = await capture(anthropicModel);
  assert.equal(anthropic.max_tokens, expectedMaximum);
  const anthropicLower = await capture(anthropicModel, 1_024);
  assert.equal(anthropicLower.max_tokens, 1_024);

  const codexModel = OPENAI_CODEX_MODELS["gpt-5.6-sol"];
  assert.ok(codexModel);
  const codex = await capture(
    codexModel,
    undefined,
    fixtureOpenAICodexJwt()
  );
  const codexLower = await capture(
    codexModel,
    1_024,
    fixtureOpenAICodexJwt()
  );
  for (const payload of [codex, codexLower]) {
    assert.equal(Object.hasOwn(payload, "max_tokens"), false);
    assert.equal(Object.hasOwn(payload, "max_completion_tokens"), false);
    assert.equal(Object.hasOwn(payload, "max_output_tokens"), false);
  }
}

async function assertSpecialProviderPayloadLimitContract(): Promise<void> {
  const catalog = resolveEchoInkPiCatalogModel(
    "qwen-token-plan-cn",
    "qwen3.7-plus"
  );
  assert.ok(catalog);
  const context: Context = {
    messages: [{
      role: "user",
      content: "Capture the custom adapter output limit.",
      timestamp: 1
    }],
    tools: []
  };
  const qwenModel: Model<Api> = {
    ...structuredClone(catalog),
    baseUrl: QWEN_TOKEN_PLAN_API_BASE_URL,
    contextWindow: 6_000,
    maxTokens: 4_096
  };
  const loopbackModel: Model<Api> = {
    ...structuredClone(qwenModel),
    provider: "ollama",
    id: "fixture-loopback-max-output",
    baseUrl: "http://127.0.0.1:11434/v1"
  };
  const completionBody = (model: string): string => [
    `data: ${JSON.stringify({
      id: "fixture-max-output-response",
      model,
      choices: [{
        delta: { content: "OK" },
        finish_reason: "stop"
      }]
    })}`,
    "data: [DONE]",
    ""
  ].join("\n\n");

  const captureQwen = async (
    maxTokens?: number
  ): Promise<Record<string, unknown>> => {
    let payload: Record<string, unknown> | undefined;
    const adapter = createQwenTokenPlanOpenAICompletionsAdapter(
      async (request) => {
        payload = JSON.parse(request.body) as Record<string, unknown>;
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: completionBody(qwenModel.id)
        };
      }
    );
    await adapter.streamSimple(qwenModel, context, {
      apiKey: "fixture-qwen-max-output-key",
      ...(maxTokens === undefined ? {} : { maxTokens }),
      maxRetries: 0,
      timeoutMs: 1_000
    }).result();
    assert.ok(payload);
    return payload;
  };
  const captureLoopback = async (
    maxTokens?: number
  ): Promise<Record<string, unknown>> => {
    let payload: Record<string, unknown> | undefined;
    const adapter = createLoopbackOpenAICompletionsAdapter(
      async (request) => {
        assert.ok(request.body);
        payload = JSON.parse(request.body) as Record<string, unknown>;
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: completionBody(loopbackModel.id)
        };
      }
    );
    await adapter.streamSimple(loopbackModel, context, {
      ...(maxTokens === undefined ? {} : { maxTokens }),
      maxRetries: 0,
      timeoutMs: 1_000
    }).result();
    assert.ok(payload);
    return payload;
  };

  const expectedMaximum = clampMaxTokensToContext(
    qwenModel,
    context,
    qwenModel.maxTokens
  );
  assert.ok(expectedMaximum < qwenModel.maxTokens);
  assert.equal((await captureQwen()).max_tokens, expectedMaximum);
  assert.equal((await captureQwen(1_024)).max_tokens, 1_024);
  assert.equal((await captureLoopback()).max_tokens, expectedMaximum);
  assert.equal((await captureLoopback(1_024)).max_tokens, 1_024);
}

async function assertAnthropicDocumentTransportContract(): Promise<void> {
  const model = createPiProviderModelDefinition({
    providerId: "anthropic",
    apiProtocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelRef: "claude-sonnet-5",
    contextWindow: 200_000,
    maxOutputTokens: 8_192
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const document = Object.freeze({
    attachment: Object.freeze({
      type: "file" as const,
      name: "frozen.pdf",
      path: "/private/must-not-leak/frozen.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      availability: "available" as const
    }),
    kind: "pdf" as const,
    bytes,
    sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    transport: "native" as const,
    text: "FROZEN_DOCUMENT_FALLBACK"
  });
  const capabilityTarget = {
    providerId: "anthropic",
    apiProtocol: "anthropic-messages" as const,
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-5",
    adapter: PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER
  };
  const context: Context = {
    messages: [{
      role: "user",
      content: "summarize the attached document",
      timestamp: 1
    }],
    tools: []
  };
  const provider = {
    providerId: "anthropic",
    apiProtocol: "anthropic-messages" as const,
    authMode: "api-key" as const,
    baseUrl: "https://api.anthropic.com",
    modelRef: "claude-sonnet-5"
  };
  const streamInput = {
    runId: "document-transport-run",
    conversationId: "document-transport-conversation",
    turnId: "document-transport-turn",
    correlationId: "document-transport-correlation",
    provider,
    model,
    context,
    options: {
      maxTokens: 512,
      temperature: 0,
      cacheRetention: "none" as const,
      maxRetries: 0,
      timeoutMs: 1_000
    }
  };

  let calls = 0;
  const payloads: unknown[] = [];
  const contexts: Context[] = [];
  const usageEvents: UsageRequestEvent[] = [];
  const observedContexts: Readonly<Context>[] = [];
  const fallbackAdapter = providerStreamFixture(async (
    requestedModel,
    requestContext,
    options
  ) => {
    calls += 1;
    contexts.push(structuredClone(requestContext));
    payloads.push(await fixtureProviderPayload(options, requestedModel));
    if (calls === 1) {
      await options?.onResponse?.({ status: 400, headers: {} }, requestedModel);
      return { status: "error" as const, message: "document blocks are unsupported" };
    }
    return { status: "done" as const, toolUse: calls === 2 };
  });
  const fallbackTransport = new PiProviderProtocolTransport({
    authorityId: "document-transport-authority",
    storeSetId: "document-transport-store",
    resolveAuthToken: async () => "fixture-document-key",
    recordUsage: (event) => { usageEvents.push(event); },
    observeRequest: (context) => { observedContexts.push(structuredClone(context)); },
    dispatcher: new PiProviderProtocolDispatcher({
      "anthropic-messages": fallbackAdapter
    }),
    documentInput: {
      currentDocuments: () => [document],
      capabilityTarget
    }
  });
  const fallbackResult = await (
    await fallbackTransport.stream(streamInput)
  ).result();
  assert.equal(fallbackResult.stopReason, "toolUse");
  const afterToolResult = await (
    await fallbackTransport.stream({
      ...streamInput,
      context: {
        ...context,
        messages: [...context.messages, fallbackResult, {
          role: "toolResult",
          toolCallId: "fixture-document-tool-call",
          toolName: "fixture_document_tool",
          content: [{ type: "text", text: "fixture tool result" }],
          isError: false,
          timestamp: 3
        }]
      }
    })
  ).result();
  assert.equal(afterToolResult.stopReason, "stop");
  assert.equal(calls, 3, "tool continuation adds one text-only Provider request");
  assert.equal(usageEvents.length, 2, "rejected native PDF has no fabricated usage; fallback and tool continuation each count once");
  assert.equal(new Set(usageEvents.map((event) => event.requestId)).size, 2);
  assert.deepEqual(usageEvents.map((event) => event.inputTokens), contexts.slice(1).map(estimateUsageInputTokens));
  assert.deepEqual(observedContexts, contexts, "sidebar observes each actual dispatched context, including PDF fallback");
  assert.match(JSON.stringify(payloads[0]), /"type":"document"/u);
  assert.doesNotMatch(JSON.stringify(payloads[1]), /"type":"document"/u);
  assert.doesNotMatch(JSON.stringify(payloads[2]), /"type":"document"/u);
  assert.equal(
    payloads.filter((payload) => /"type":"document"/u.test(JSON.stringify(payload))).length,
    1,
    "one Turn attempts native document input only once across tool loops"
  );
  assert.match(JSON.stringify(contexts[1]), /FROZEN_DOCUMENT_FALLBACK/u);
  assert.match(JSON.stringify(contexts[2]), /FROZEN_DOCUMENT_FALLBACK/u);
  assert.doesNotMatch(JSON.stringify([payloads, contexts]), /must-not-leak/u);

  for (const failure of [
    { status: null, message: "fetch failed", emitStart: false, textless: false },
    { status: 401, message: "document authorization failed", emitStart: false, textless: false },
    { status: 429, message: "document rate limit", emitStart: false, textless: false },
    { status: 400, message: "invalid PDF payload", emitStart: false, textless: false },
    { status: 400, message: "document blocks are unsupported", emitStart: true, textless: false },
    {
      status: 400,
      message: "document blocks are unsupported",
      emitStart: false,
      textless: false,
      partialText: "PARTIAL_DOCUMENT_ANSWER"
    },
    { status: 400, message: "document blocks are unsupported", emitStart: false, textless: true }
  ]) {
    let failureCalls = 0;
    const adapter = providerStreamFixture(async (requestedModel, _context, options) => {
      failureCalls += 1;
      await fixtureProviderPayload(options, requestedModel);
      if (failure.status !== null) {
        await options?.onResponse?.({ status: failure.status, headers: {} }, requestedModel);
      }
      return {
        status: "error" as const,
        message: failure.message,
        emitStart: failure.emitStart,
        partialText: failure.partialText
      };
    });
    const transport = new PiProviderProtocolTransport({
      authorityId: `document-no-retry-${failure.status ?? "network"}`,
      storeSetId: "document-no-retry-store",
      resolveAuthToken: async () => "fixture-document-key",
      dispatcher: new PiProviderProtocolDispatcher({
        "anthropic-messages": adapter
      }),
      documentInput: {
        currentDocuments: () => failure.textless
          ? [Object.freeze({ ...document, text: undefined })]
          : [document],
        capabilityTarget
      }
    });
    const result = await (await transport.stream(streamInput)).result();
    assert.equal(result.stopReason, "error");
    assert.equal(failureCalls, 1, `${failure.status ?? "network"} must not retry`);
    if (failure.partialText) {
      assert.match(JSON.stringify(result.content), /PARTIAL_DOCUMENT_ANSWER/u);
    }
  }

  let overBudgetCalls = 0;
  const overBudgetAdapter = providerStreamFixture(async (
    requestedModel,
    _requestContext,
    options
  ) => {
    overBudgetCalls += 1;
    await fixtureProviderPayload(options, requestedModel);
    await options?.onResponse?.({ status: 400, headers: {} }, requestedModel);
    return {
      status: "error" as const,
      message: "document blocks are unsupported"
    };
  });
  const overBudgetDocument = Object.freeze({
    ...document,
    text: "frozen fallback text ".repeat(2_000)
  });
  const overBudgetModel = createPiProviderModelDefinition({
    providerId: "anthropic",
    apiProtocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelRef: "claude-sonnet-5",
    contextWindow: 1_024,
    maxOutputTokens: 128
  });
  const overBudgetTransport = new PiProviderProtocolTransport({
    authorityId: "document-over-budget-authority",
    storeSetId: "document-over-budget-store",
    resolveAuthToken: async () => "fixture-document-key",
    dispatcher: new PiProviderProtocolDispatcher({
      "anthropic-messages": overBudgetAdapter
    }),
    documentInput: {
      currentDocuments: () => [overBudgetDocument],
      capabilityTarget
    }
  });
  const overBudgetResult = await (
    await overBudgetTransport.stream({
      ...streamInput,
      model: overBudgetModel,
      options: {
        ...streamInput.options,
        maxTokens: 128
      }
    })
  ).result();
  assert.equal(overBudgetResult.stopReason, "error");
  assert.equal(
    overBudgetResult.errorMessage,
    PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
  );
  assert.equal(
    overBudgetCalls,
    1,
    "fallback context over budget must not dispatch a second request"
  );
}

async function assertUsageGenerationWiring(): Promise<void> {
  const usage: UsageRequestEvent[] = [];
  const contexts: Context[] = [];
  const adapter = providerStreamFixture(async (_model, context) => {
    contexts.push(structuredClone(context));
    return { status: "done", partialText: "统一统计 OK" };
  });
  const draft = { ...providerModelDiscoveryDraft("openai-completions"), modelId: "usage-fixture", apiKey: "fixture-key" };
  const service = new PiProviderConfigurationService({ app: new App(), settings: structuredClone(DEFAULT_SETTINGS), getVaultPath: () => "/fixture-vault" } as never, {
    adapters: { "openai-completions": adapter },
    recordUsage: (event) => { usage.push(event); }
  });
  assert.equal(await service.generateText({ draft, systemPrompt: "Context", userPrompt: "测试中文 input", timeoutMs: 1_000 }), "统一统计 OK");
  assert.equal((await service.testConnection(draft)).status, "available");
  assert.deepEqual(usage.map((event) => event.source), ["background", "connection-test"]);
  assert.deepEqual(usage.map((event) => event.inputTokens), contexts.map(estimateUsageInputTokens));
  assert.ok(usage.every((event) => event.outputTokens > 0 && event.standard === "echoink-o200k-v1"));
}

function providerStreamFixture(
  respond: (
    model: Model<Api>,
    context: Context,
    options: StreamOptions | undefined
  ) => Promise<Readonly<{
    status: "done" | "error";
    message?: string;
    emitStart?: boolean;
    partialText?: string;
    toolUse?: boolean;
  }>>
): ProviderStreams {
  const run = (
    model: Model<Api>,
    context: Context,
    options?: StreamOptions
  ) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const response = await respond(model, context, options);
      const message = fixtureAssistantMessage(
        model,
        response.message,
        response.toolUse === true,
        response.partialText
      );
      if (response.emitStart) output.push({ type: "start", partial: message });
      if (response.status === "done") {
        output.push({ type: "done", reason: "stop", message });
      } else {
        output.push({ type: "error", reason: "error", error: message });
      }
    })();
    return output;
  };
  return { stream: run, streamSimple: run };
}

async function fixtureProviderPayload(
  options: StreamOptions | undefined,
  model: Model<Api>
): Promise<unknown> {
  const payload = {
    model: model.id,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "summarize the attached document" }]
    }]
  };
  return await options?.onPayload?.(payload, model) ?? payload;
}

function fixtureAssistantMessage(
  model: Model<Api>,
  errorMessage?: string,
  toolUse = false,
  partialText?: string
): AssistantMessage {
  return {
    role: "assistant",
    content: partialText
      ? [{ type: "text", text: partialText }]
      : errorMessage
      ? []
      : toolUse
        ? [{
            type: "toolCall",
            id: "fixture-document-tool-call",
            name: "fixture_document_tool",
            arguments: {}
          }]
        : [{ type: "text", text: "done" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: errorMessage && !partialText ? 0 : 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: errorMessage && !partialText ? 1 : 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: errorMessage ? "error" : toolUse ? "toolUse" : "stop",
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1
  };
}

async function assertProviderAuthResolutionFailureContract(): Promise<void> {
  const failureCode = async (
    authMode: "api-key" | "oauth",
    error: Error = new Error("fixture-auth-resolution-failed")
  ): Promise<string | undefined> => {
    const oauth = authMode === "oauth";
    const model = createPiProviderModelDefinition({
      providerId: oauth ? "openai-codex" : "deepseek",
      apiProtocol: oauth
        ? "openai-codex-responses"
        : "openai-completions",
      baseUrl: oauth
        ? "https://chatgpt.com/backend-api"
        : "https://api.deepseek.com",
      modelRef: oauth ? "gpt-5.6-sol" : "deepseek-v4-flash"
    });
    const transport = new PiProviderProtocolTransport({
      authorityId: "fixture-authority",
      storeSetId: "fixture-store-set",
      resolveAuthToken: async () => {
        throw error;
      }
    });
    const stream = await transport.stream({
      runId: "fixture-run",
      conversationId: "fixture-conversation",
      turnId: "fixture-turn",
      correlationId: "fixture-correlation",
      provider: {
        providerId: model.provider,
        apiProtocol: model.api,
        authMode,
        baseUrl: model.baseUrl,
        modelRef: model.id
      },
      model,
      context: { messages: [], tools: [] },
      options: {
        maxTokens: 32,
        temperature: 0,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs: 1_000
      }
    });
    const message = await stream.result();
    assert.equal(JSON.stringify(message).includes("fixture private auth detail"), false);
    return message.errorMessage;
  };

  assert.equal(
    await failureCode("oauth"),
    "provider_service_unavailable"
  );
  assert.equal(
    await failureCode("api-key"),
    "provider_api_key_missing"
  );
  for (const code of [
    "provider_network_error",
    "provider_oauth_relogin_required",
    "provider_service_unavailable",
    "provider_rate_limited",
    "provider_protocol_failed"
  ]) {
    assert.equal(await failureCode("oauth", Object.assign(
      new Error("fixture private auth detail"), { code }
    )), code);
  }
}

function assertProviderTooltipBehavior(): void {
  assert.equal(
    providerTooltipBaseUrl("deepseek", "https://ignored.example.com"),
    "https://api.deepseek.com"
  );
  assert.equal(
    providerTooltipBaseUrl("custom", "  https://custom.example.com/v1  "),
    "https://custom.example.com/v1"
  );
  assert.equal(providerTooltipBaseUrl("custom", "   "), "");
  assert.equal(
    providerTooltipBaseUrl("openai-codex", "https://ignored.example.com"),
    ""
  );
}

function assertSavedModelLifecycle(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const primary = createApiProviderConfig("deepseek", "primary");
  const fallback = createApiProviderConfig("ollama", "fallback");
  settings.apiProviders = [primary, fallback];

  activateApiProvider(settings, primary);
  assert.equal(settings.activeApiProviderId, primary.id);
  const primaryModelId = primary.defaultModelId;
  const alternate = API_PROVIDER_PRESETS.find(
    (preset) => preset.id === "deepseek"
  )?.models[1]?.id;
  assert.ok(alternate);
  assert.equal(applyApiProviderModelPreset(primary, alternate), true);
  assert.deepEqual(
    primary.models.map((model) => model.id),
    [primaryModelId, alternate]
  );
  assert.equal(primary.defaultModelId, alternate);
  const alternateModel = primary.models.find((model) => model.id === alternate);
  assert.ok(alternateModel);
  alternateModel.reasoningEffort = "max";
  assert.equal(applyApiProviderModelPreset(primary, alternate), true);
  assert.equal(
    primary.models.find((model) => model.id === alternate)?.reasoningEffort,
    "max"
  );
  assert.equal(removeApiProvider(settings, primary.id), true);
  assert.equal(settings.activeApiProviderId, fallback.id);
  assert.equal(removeApiProvider(settings, fallback.id), true);
  assert.equal(settings.activeApiProviderId, "");
}

async function assertSavedBindingPreflightLifecycle(): Promise<void> {
  const provider = createApiProviderConfig("deepseek", "saved-provider");
  provider.apiKey = "saved-provider-api-key";
  const model = primaryProviderModel(provider);
  const draft: PiProviderConfigurationDraft = {
    providerSettingsId: provider.id,
    providerId: "deepseek",
    runtimeProviderId: provider.runtimeProviderId,
    apiProtocol: provider.apiProtocol,
    authMode: provider.authMode,
    baseUrl: provider.baseUrl,
    modelId: model.id,
    apiKey: "",
    toolCalling: model.toolCalling,
    imageInput: model.input.includes("image"),
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    modelMaxTokens: model.modelMaxTokens,
    maxOutputTokens: model.maxOutputTokens
  };
  assert.equal(providerPreflightApiKeyReady({
    providerId: "deepseek",
    apiKey: "",
    storedApiKey: provider.apiKey
  }), true);

  let resolveRequested!: (result: PiProviderModelListResult) => void;
  const requestedResult = new Promise<PiProviderModelListResult>((resolve) => {
    resolveRequested = resolve;
  });
  const calls: string[] = [];
  let modelListAttempt = 0;
  let connectionAttempt = 0;
  const service = {
    listModels: async (input: PiProviderConfigurationDraft) => {
      calls.push("listModels");
      modelListAttempt += 1;
      assert.equal(input.providerSettingsId, provider.id);
      assert.equal(input.apiKey, "");
      if (modelListAttempt === 1) return await requestedResult;
      return {
        status: modelListAttempt === 2
          ? "temporary_failure" as const
          : "api_key_error" as const,
        models: []
      };
    },
    testConnection: async (input: PiProviderConfigurationDraft) => {
      calls.push("testConnection");
      connectionAttempt += 1;
      assert.equal(input.providerSettingsId, provider.id);
      assert.equal(input.apiKey, "");
      return connectionAttempt === 1
        ? { status: "failed" as const, failure: "protocol" as const }
        : { status: "available" as const };
    }
  };
  const states: string[] = [];
  const preflight = new ProviderPreflightSession(
    service,
    (state) => states.push(`${state.operation}:${state.status}`)
  );

  const requested = preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "loading");
  assert.equal(modelListAttempt, 1);
  resolveRequested({
    status: "available",
    models: [{ id: model.id }]
  });
  await requested;
  assert.equal(preflight.state.status, "available");
  assert.deepEqual(preflight.state.models, [{ id: model.id }]);

  await preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "temporary_failure");
  await preflight.discoverModels(draft);
  assert.equal(preflight.state.status, "api_key_error");
  await preflight.testConnection(draft);
  assert.equal(preflight.state.status, "unsupported");
  assert.equal(preflight.state.connectionFailure, "protocol");
  await preflight.testConnection(draft);
  assert.equal(preflight.state.status, "available");
  assert.deepEqual(calls, [
    "listModels",
    "listModels",
    "listModels",
    "testConnection",
    "testConnection"
  ]);
  assert.deepEqual(states, [
    "model_list:loading",
    "model_list:available",
    "model_list:loading",
    "model_list:temporary_failure",
    "model_list:loading",
    "model_list:api_key_error",
    "connection:loading",
    "connection:unsupported",
    "connection:loading",
    "connection:available"
  ]);
}

async function assertProviderPickerGroupingAndFiltering(): Promise<void> {
  installProviderModalDomFixture();
  const modalRegistryBaseline = openTestModals.length;
  const provider = createApiProviderConfig("deepseek", "provider-grouping-modal");
  const preflight = {
    listModels: async () => ({
      status: "available" as const,
      models: provider.models
    }),
    testConnection: async () => ({ status: "available" as const })
  };
  const createModal = (language: "zh-CN" | "en") => new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language,
    copy: settingsCopy(language),
    preflight,
    save: async () => ({ saved: true })
  });

  const modal = createModal("zh-CN");
  modal.open();
  const picker = modal.contentEl.querySelector<ProviderModalTestElement>(
    ".codex-provider-combobox"
  );
  const options = picker?.querySelector<ProviderModalTestElement>(
    ".codex-provider-combobox-options"
  );
  const trigger = picker?.querySelector<ProviderModalTestElement>(
    ".codex-provider-combobox-trigger"
  );
  const search = picker?.querySelector<ProviderModalTestElement>(
    'input[aria-label="搜索 Provider"]'
  );
  assert.ok(picker && options && trigger && search);
  assert.equal(openTestModals.length, modalRegistryBaseline + 1);
  assert.equal(
    trigger.querySelector(".codex-provider-option-name")?.textContent,
    "深度求索"
  );
  const configuredName = providerModalElementByFocusKey(modal, "name");
  assert.ok(configuredName);
  assert.equal(configuredName.value, "");
  assert.equal(configuredName.getAttribute("maxlength"), "80");
  assert.equal(configuredName.getAttribute("placeholder"), "留空则显示“深度求索”");
  const configuredNameField = configuredName.closest<ProviderModalTestElement>(
    ".codex-provider-modal-field"
  );
  const apiKeyField = providerModalElementByFocusKey(modal, "apiKey")
    ?.closest<ProviderModalTestElement>(".codex-provider-modal-field");
  const modalForm = modal.contentEl.querySelector<ProviderModalTestElement>(
    ".codex-provider-modal-form"
  );
  assert.ok(configuredNameField && apiKeyField && modalForm);
  assert.equal(
    modalForm.querySelectorAll(".codex-provider-modal-field").indexOf(configuredNameField)
      < modalForm.querySelectorAll(".codex-provider-modal-field").indexOf(apiKeyField),
    true,
    "the optional Provider name stays between Provider selection and API Key"
  );
  configuredName.value = "工作账号";
  configuredName.fireEvent("input");
  assert.equal(
    (modal as unknown as { draft: ApiProviderConfig }).draft.name,
    "工作账号"
  );
  const optionIds = options.querySelectorAll<ProviderModalTestElement>(
    ".codex-provider-combobox-option"
  ).map((option) => option.getAttribute("data-provider-id"));
  const visibleOptionIds = () => options.querySelectorAll<ProviderModalTestElement>(
    ".codex-provider-combobox-option"
  )
    .filter((option) => !option.hasClass("is-hidden"))
    .map((option) => option.getAttribute("data-provider-id"));
  assert.deepEqual(optionIds, API_PROVIDER_PRESETS.map((preset) => preset.id));
  assert.equal(optionIds.includes("grok"), false);
  assert.doesNotMatch(options.textContent, /Grok/iu);
  const providerOptionName = (
    root: ProviderModalTestElement,
    providerId: string
  ) => root.querySelector<ProviderModalTestElement>(
    `[data-provider-id="${providerId}"]`
  )?.querySelector(".codex-provider-option-name")?.textContent;
  assert.equal(providerOptionName(options, "deepseek"), "深度求索");
  assert.equal(
    providerOptionName(options, "qwen-token-plan"),
    "通义千问 Token Plan"
  );
  for (const optionName of options.querySelectorAll<ProviderModalTestElement>(
    ".codex-provider-option-name"
  )) {
    assert.doesNotMatch(optionName.textContent, / \/ /u);
  }
  const oauthPreset = API_PROVIDER_PRESETS.find((preset) => preset.id === "openai-codex");
  const tokenPlanPreset = API_PROVIDER_PRESETS.find(
    (preset) => preset.id === "qwen-token-plan"
  );
  assert.equal(oauthPreset?.group, "account");
  assert.equal(tokenPlanPreset?.group, "token-plan");
  assert.ok(oauthPreset?.baseUrl,
    "explicit grouping remains stable when a preset also defines a baseUrl");

  const selected = options.querySelector<ProviderModalTestElement>(
    '[data-provider-id="deepseek"]'
  );
  const qwen = options.querySelector<ProviderModalTestElement>(
    '[data-provider-id="qwen"]'
  );
  assert.ok(selected && qwen);
  assert.equal(selected.hasClass("is-selected"), true);
  assert.equal(selected.getAttribute("aria-selected"), "true");
  trigger.fireEvent("keydown", { key: "ArrowDown" });
  assert.equal(picker.hasClass("is-open"), true);
  assert.equal(providerModalTestDocument.activeElement, selected,
    "opening by keyboard focuses the selected Provider across groups");
  options.fireEvent("keydown", { key: "ArrowDown", target: selected });
  assert.equal(providerModalTestDocument.activeElement, qwen,
    "keyboard navigation skips headings and follows visible Provider order");

  const headings = modal.contentEl.querySelectorAll<ProviderModalTestElement>(
    ".provider-group-button"
  );
  assert.deepEqual(headings.map((heading) => heading.textContent), [
    "登录账户",
    "供应商",
    "Token Plan",
    "其他"
  ]);
  search.value = "codex";
  search.fireEvent("input");
  assert.deepEqual(visibleOptionIds(), ["openai-codex"]);
  search.fireEvent("keydown", { key: "ArrowDown" });
  assert.equal(
    providerModalTestDocument.activeElement?.getAttribute("data-provider-id"),
    "openai-codex"
  );
  search.value = "deepseek";
  search.fireEvent("input");
  assert.deepEqual(visibleOptionIds(), ["deepseek"]);
  search.value = "custom";
  search.fireEvent("input");
  assert.deepEqual(visibleOptionIds(), ["custom"]);
  search.value = "no matching provider";
  search.fireEvent("input");
  assert.deepEqual(visibleOptionIds(), []);
  search.value = "";
  search.fireEvent("input");
  assert.deepEqual(visibleOptionIds(), API_PROVIDER_PRESETS.filter((preset) => preset.group === "provider").map((preset) => preset.id));
  headings[0].click();
  assert.deepEqual(visibleOptionIds(), ["openai-codex"]);
  headings[2].click();
  assert.deepEqual(visibleOptionIds(), API_PROVIDER_PRESETS.filter((preset) => preset.group === "token-plan").map((preset) => preset.id));
  headings[1].click();
  assert.equal(selected.getAttribute("aria-selected"), "true",
    "filtering never changes the selected Provider");

  options.fireEvent("keydown", {
    key: "Escape",
    target: providerModalTestDocument.activeElement
  });
  assert.equal(picker.hasClass("is-open"), false);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(providerModalTestDocument.activeElement, trigger);
  const beforeSelectedScroll = selected.scrollIntoViewCalls;
  trigger.click();
  assert.equal(selected.scrollIntoViewCalls, beforeSelectedScroll + 1, "pointer opening brings the current Provider into the constrained list viewport");
  assert.equal(providerModalTestDocument.activeElement, search, "showing the current Provider preserves search focus");
  headings[0].click();
  search.value = "codex";
  search.fireEvent("input");
  search.fireEvent("keydown", { key: "Escape", isComposing: true });
  assert.equal(picker.hasClass("is-open"), true, "IME Escape must not close the picker");
  search.fireEvent("keydown", { key: "Escape" });
  trigger.fireEvent("keydown", { key: "ArrowDown" });
  assert.equal(search.value, "");
  assert.equal(headings[1].getAttribute("aria-pressed"), "true", "reopening restores the selected Provider category");
  assert.equal(providerModalTestDocument.activeElement, selected);
  assert.ok(picker.querySelector(".provider-picker-footer")?.textContent.includes("Enter"));
  search.value = "codex";
  search.fireEvent("input");
  headings[1].click();
  assert.equal(search.value, "", "choosing a category clears the cross-category query");
  options.fireEvent("keydown", { key: "ArrowLeft", target: selected });
  assert.equal(providerModalTestDocument.activeElement, headings[1]);
  headings[1].fireEvent("keydown", { key: "End" });
  assert.equal(providerModalTestDocument.activeElement, headings[3]);
  headings[3].fireEvent("keydown", { key: "Escape" });
  assert.equal(picker.hasClass("is-open"), false);
  modal.close();
  assert.equal(openTestModals.length, modalRegistryBaseline,
    "closing the grouped Provider Modal must release the fake Modal registry");
  providerModalTestDocument.activeElement = null;
  await flushProviderModalTasks();

  const englishModal = createModal("en");
  englishModal.open();
  assert.equal(openTestModals.length, modalRegistryBaseline + 1);
  const englishTrigger = englishModal.contentEl.querySelector<ProviderModalTestElement>(
    ".codex-provider-combobox-trigger"
  );
  const englishOptions = englishModal.contentEl.querySelector<ProviderModalTestElement>(
    ".codex-provider-combobox-options"
  );
  assert.ok(englishTrigger && englishOptions);
  const englishConfiguredName = providerModalElementByFocusKey(
    englishModal,
    "name"
  );
  assert.ok(englishConfiguredName);
  assert.equal(
    englishConfiguredName.getAttribute("placeholder"),
    "Leave blank to show “DeepSeek”"
  );
  assert.equal(
    englishTrigger.querySelector(".codex-provider-option-name")?.textContent,
    "DeepSeek"
  );
  assert.equal(providerOptionName(englishOptions, "deepseek"), "DeepSeek");
  assert.equal(
    providerOptionName(englishOptions, "qwen-token-plan"),
    "Qwen Token Plan"
  );
  for (const optionName of englishOptions.querySelectorAll<ProviderModalTestElement>(
    ".codex-provider-option-name"
  )) {
    assert.doesNotMatch(optionName.textContent, / \/ /u);
  }
  assert.deepEqual(
    englishModal.contentEl.querySelectorAll<ProviderModalTestElement>(
      ".provider-group-button"
    ).map((heading) => heading.textContent),
    ["Account sign-in", "Providers", "Token plans", "Other"]
  );
  englishModal.close();
  await flushProviderModalTasks();
  assert.equal(openTestModals.length, modalRegistryBaseline,
    "the English Provider Modal must also release the fake Modal registry");
}

async function assertOpenAICodexModalLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const provider = createApiProviderConfig(
    "openai-codex",
    "codex-oauth-modal"
  );
  const openedUrls: string[] = [];
  let modelListCalls = 0;
  let logoutCalls = 0;
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: false,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => {
        modelListCalls += 1;
        return {
          status: "available",
          models: provider.models.map((model) => ({ id: model.id }))
        };
      },
      testConnection: async () => {
        assert.fail("Codex OAuth must not expose an API-key connection test");
      }
    },
    codexOAuth: {
      status: async () => ({ state: "disconnected" }),
      openExternal: async (url) => {
        openedUrls.push(url);
        return true;
      },
      login: async (interaction) => {
        const method = await interaction.prompt({
          type: "select",
          message: "fixture",
          options: [{ id: "browser", label: "Browser" }]
        });
        assert.equal(method, "browser");
        interaction.notify({
          type: "auth_url",
          url: "https://auth.openai.com/fixture"
        });
        const code = await interaction.prompt({
          type: "manual_code",
          message: "fixture"
        });
        assert.equal(code, "fixture-authorization-code");
        return { state: "connected" };
      },
      logout: async () => { logoutCalls += 1; }
    },
    save: async () => ({ saved: true })
  });
  modal.open();
  await flushProviderModalTasks();
  assert.equal(modelListCalls, 0);
  assert.match(modal.contentEl.textContent, /Beta/u);
  assert.match(modal.contentEl.textContent, /OpenAI browser authorization/u);
  assert.doesNotMatch(modal.contentEl.textContent, /API Key/u);
  assert.equal(
    modal.titleEl.querySelector(".codex-provider-protocol-pill"),
    null
  );
  assert.ok(provider.models.length > 0);
  for (const model of provider.models) {
    assert.equal(providerModalElementByFocusKey(modal, `model-enabled:${model.id}`)?.checked, true);
  }
  assert.equal(providerModalElementByFocusKey(modal, "save")?.disabled, true);

  const login = Array.from(modal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "Sign in with OpenAI");
  assert.ok(login);
  login.click();
  await flushProviderModalTasks();
  assert.deepEqual(openedUrls, ["https://auth.openai.com/fixture"]);
  const manual = modal.contentEl.querySelector<HTMLInputElement>(
    '[data-modal-focus-key="codex-oauth-manual"]'
  );
  assert.ok(manual);
  manual.value = "fixture-authorization-code";
  manual.oninput?.(new Event("input"));
  const finish = Array.from(modal.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "Complete authorization");
  assert.ok(finish);
  assert.equal(finish.disabled, false);
  finish.click();
  await flushProviderModalTasks();
  assert.equal(modelListCalls, 0, "OAuth completion must not request models");
  assert.match(modal.contentEl.textContent, /OpenAI Codex is connected/u);
  assert.equal(providerModalElementByFocusKey(modal, "save")?.disabled, false);
  assert.equal(providerModalElementByFocusKey(modal, "provider-test-connection"), null);
  const logout = providerModalElementByFocusKey(modal, "codex-oauth-logout");
  assert.ok(logout);
  logout.click();
  await flushProviderModalTasks();
  assert.equal(logoutCalls, 1);
  assert.ok(providerModalElementByFocusKey(modal, "codex-oauth-login"));
  assert.equal(providerModalElementByFocusKey(modal, "save")?.disabled, true);
  assert.equal(modelListCalls, 0, "OAuth login and logout must not request models");
  modal.close();

  let expiredSaveCalls = 0;
  const expiredModal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async () => { assert.fail("Opening expired OAuth must not request models"); },
      testConnection: async () => { assert.fail("Saving expired OAuth must not test the connection"); }
    },
    codexOAuth: {
      status: async () => ({ state: "expired" }),
      openExternal: async () => true,
      login: async () => { assert.fail("Refreshable OAuth must not require a new sign-in"); },
      logout: async () => undefined
    },
    save: async () => { expiredSaveCalls += 1; return { saved: true }; }
  });
  expiredModal.open();
  await flushProviderModalTasks();
  assert.match(
    expiredModal.contentEl.textContent,
    /Connected; authorization refreshes safely on the next request\./u
  );
  assert.ok(providerModalElementByFocusKey(expiredModal, "codex-oauth-logout"));
  assert.equal(providerModalElementByFocusKey(expiredModal, "codex-oauth-login"), null);
  const save = providerModalElementByFocusKey(expiredModal, "save");
  assert.ok(save);
  assert.equal(save.disabled, false);
  save.click();
  await flushProviderModalTasks();
  assert.equal(expiredSaveCalls, 1);
  expiredModal.close();
}

async function assertFreshCustomModelDiscoveryLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const provider = createApiProviderConfig("custom", "fresh-custom-discovery");
  const calls: PiProviderConfigurationDraft[] = [];
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: false,
    language: "en",
    copy: settingsCopy("en"),
    preflight: {
      listModels: async (draft) => {
        calls.push(structuredClone(draft));
        return { status: "available", models: [{ id: "current-custom-model" }] };
      },
      testConnection: async () => ({ status: "available" })
    },
    save: async () => ({ saved: true })
  });
  modal.open();
  const endpoint = providerModalElementByFocusKey(modal, "endpoint");
  const apiKey = providerModalElementByFocusKey(modal, "apiKey");
  const discover = providerModalElementByFocusKey(modal, "model-discover");
  assert.ok(endpoint && apiKey && discover);
  assert.equal(discover.disabled, true);
  assert.equal(calls.length, 0);

  endpoint.value = "https://current-custom.example/v1";
  endpoint.oninput?.(new Event("input"));
  assert.equal(discover.disabled, true);
  apiKey.value = "fixture-current-custom-key";
  apiKey.oninput?.(new Event("input"));
  assert.equal(discover.disabled, false);
  assert.equal(calls.length, 0, "typing must not request a model list");

  endpoint.value = "";
  endpoint.oninput?.(new Event("input"));
  assert.equal(discover.disabled, true);
  endpoint.value = "https://current-custom.example/v1";
  endpoint.oninput?.(new Event("input"));
  assert.equal(discover.disabled, false);
  apiKey.value = "";
  apiKey.oninput?.(new Event("input"));
  assert.equal(discover.disabled, true);
  apiKey.value = "fixture-current-custom-key";
  apiKey.oninput?.(new Event("input"));
  assert.equal(discover.disabled, false);
  assert.equal(calls.length, 0);

  discover.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.baseUrl, "https://current-custom.example/v1");
  assert.equal(calls[0]?.apiKey, "fixture-current-custom-key");
  assert.ok(providerModalElementByFocusKey(modal, "manual-model"));
  await flushProviderModalTasks();
  const discoveredEnabled = providerModalElementByFocusKey(
    modal,
    "model-enabled:current-custom-model"
  );
  assert.ok(discoveredEnabled);
  discoveredEnabled.checked = true;
  discoveredEnabled.onchange?.(new Event("change"));
  const discoveredReasoning = providerModalElementByFocusKey(
    modal,
    "toggle:model:current-custom-model:reasoning"
  );
  assert.ok(discoveredReasoning);
  assert.equal(discoveredReasoning.checked, true);
  assert.equal(discoveredReasoning.disabled, false);

  const manualModel = providerModalElementByFocusKey(modal, "manual-model");
  const addManualModel = providerModalElementByFocusKey(
    modal,
    "manual-model-add"
  );
  assert.ok(manualModel && addManualModel);
  manualModel.value = "manual-unknown-model";
  manualModel.oninput?.(new Event("input"));
  addManualModel.click();
  const manualReasoning = providerModalElementByFocusKey(
    modal,
    "toggle:model:manual-unknown-model:reasoning"
  );
  assert.ok(manualReasoning);
  assert.equal(manualReasoning.checked, true);
  assert.equal(manualReasoning.disabled, false);
  modal.close();
}

async function assertProviderLimitOverrideRoundTrip(): Promise<void> {
  installProviderModalDomFixture();
  const provider = createApiProviderConfig("deepseek", "limit-round-trip");
  provider.apiKey = "fixture-limit-round-trip-key";
  const modelId = primaryProviderModel(provider).id;
  let savedDraft: ApiProviderConfig | undefined;
  let connectionCalls = 0;
  const openModal = (
    draft: ApiProviderConfig,
    save: (next: ApiProviderConfig) => void
  ): ProviderModelModal => {
    const modal = new ProviderModelModal({
      app: new App(),
      draft,
      editing: true,
      language: "en",
      copy: settingsCopy("en"),
      preflight: {
        listModels: async () => ({ status: "available", models: [] }),
        testConnection: async () => { connectionCalls++; return { status: "available" }; }
      },
      save: async (next) => {
        save(structuredClone(next));
        return { saved: true };
      }
    });
    modal.open();
    return modal;
  };

  const first = openModal(provider, (next) => {
    savedDraft = next;
  });
  const limitKey = `model:${modelId}:contextWindow`;
  const initialInput = providerModalElementByFocusKey(first, limitKey)!;
  const panel = initialInput.closest<HTMLElement>("[data-model-advanced-key]")!;
  const parametersKey = `model:${modelId}:parameters`;
  const initialToggle = providerModalElementByFocusKey(first, parametersKey)!;
  assert.equal(panel.hidden, true);
  initialToggle.click();
  assert.equal(panel.hidden, false);
  assert.equal(initialToggle.getAttribute("aria-expanded"), "true");
  for (const raw of ["1.5", "2000001", "invalid-number"]) {
    const input = providerModalElementByFocusKey(first, limitKey)!;
    input.value = raw; input.fireEvent("input");
    providerModalElementByFocusKey(first, "save")?.click();
    await flushProviderModalTasks();
    const preserved = providerModalElementByFocusKey(first, limitKey)!;
    assert.equal(savedDraft, undefined, "an invalid visible parameter cannot silently save the old value");
    assert.equal(preserved.value, raw);
    assert.equal(preserved.getAttribute("aria-invalid"), "true");
    assert.doesNotMatch(first.contentEl.textContent, /valid Model ID without spaces/u, "a parameter error must not be presented as an invalid manual Model ID");
    assert.equal(preserved.closest<HTMLElement>("[data-model-advanced-key]")?.hidden, false, "invalid parameters stay expanded after validation");
    assert.equal(providerModalTestDocument.activeElement, preserved);
    providerModalElementByFocusKey(first, "provider-test-connection")?.click();
    await flushProviderModalTasks();
    assert.equal(connectionCalls, 0, "invalid parameters block the real test-connection chain");
  }
  for (const [key, value] of [
    ["contextWindow", "120000"],
    ["modelMaxTokens", "16000"],
    ["maxOutputTokens", "12000"]
  ] as const) {
    const input = providerModalElementByFocusKey(
      first,
      `model:${modelId}:${key}`
    );
    assert.ok(input);
    input.value = value;
    input.oninput?.(new Event("input"));
  }
  const fieldBeforeCollapse = providerModalElementByFocusKey(first, limitKey)!;
  const parametersToggle = providerModalElementByFocusKey(first, parametersKey)!;
  parametersToggle.focus(); parametersToggle.click();
  assert.equal(fieldBeforeCollapse.closest<HTMLElement>("[data-model-advanced-key]")?.hidden, true);
  assert.equal(parametersToggle.getAttribute("aria-expanded"), "false");
  parametersToggle.click();
  assert.equal(providerModalElementByFocusKey(first, limitKey), fieldBeforeCollapse, "collapse and reopen preserve the actual parameter field");
  assert.equal(fieldBeforeCollapse.value, "120000");
  assert.equal(providerModalTestDocument.activeElement, parametersToggle, "parameter toggle keeps keyboard focus without redrawing the form");
  const defaultControl = providerModalElementByFocusKey(first, `model-default:${modelId}`)!;
  defaultControl.checked = true;
  defaultControl.fireEvent("change");
  assert.equal(providerModalElementByFocusKey(first, limitKey)?.closest<HTMLElement>("[data-model-advanced-key]")?.hidden, false,
    "changing the default keeps an already expanded parameter section open");
  providerModalElementByFocusKey(first, "save")?.click();
  await flushProviderModalTasks();
  assert.ok(savedDraft);
  assert.deepEqual(primaryProviderModel(savedDraft).limitsOverride, {
    contextWindow: 120_000,
    modelMaxTokens: 16_000,
    maxOutputTokens: 12_000
  });

  let clearedDraft: ApiProviderConfig | undefined;
  const reopened = openModal(savedDraft, (next) => {
    clearedDraft = next;
  });
  for (const [key, value] of [
    ["contextWindow", "120000"],
    ["modelMaxTokens", "16000"],
    ["maxOutputTokens", "12000"]
  ] as const) {
    const input = providerModalElementByFocusKey(
      reopened,
      `model:${modelId}:${key}`
    );
    assert.ok(input);
    assert.equal(input.value, value);
    input.value = "";
    input.oninput?.(new Event("input"));
  }
  providerModalElementByFocusKey(reopened, "save")?.click();
  await flushProviderModalTasks();
  assert.ok(clearedDraft);
  const cleared = primaryProviderModel(clearedDraft);
  const baseline = createApiProviderModelConfig("deepseek", modelId);
  assert.equal(Object.hasOwn(cleared, "limitsOverride"), false);
  assert.deepEqual({
    contextWindow: cleared.contextWindow,
    modelMaxTokens: cleared.modelMaxTokens,
    maxOutputTokens: cleared.maxOutputTokens
  }, {
    contextWindow: baseline.contextWindow,
    modelMaxTokens: baseline.modelMaxTokens,
    maxOutputTokens: baseline.maxOutputTokens
  });
}

async function assertProviderModelModalPreflightLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const copy = settingsCopy("en");
  const provider = createApiProviderConfig("deepseek", "saved-modal-provider");
  provider.apiKey = "saved-modal-provider-api-key";
  const discovery = deferred<PiProviderModelListResult>();
  const connections = [
    deferred<PiProviderConnectionTestResult>(),
    deferred<PiProviderConnectionTestResult>()
  ];
  const calls: Array<{
    operation: "listModels" | "testConnection";
    draft: PiProviderConfigurationDraft;
  }> = [];
  let connectionAttempt = 0;
  const service = {
    listModels: async (draft: PiProviderConfigurationDraft) => {
      calls.push({ operation: "listModels", draft: structuredClone(draft) });
      return await discovery.promise;
    },
    testConnection: async (draft: PiProviderConfigurationDraft) => {
      calls.push({ operation: "testConnection", draft: structuredClone(draft) });
      const pending = connections[connectionAttempt++];
      assert.ok(pending);
      return await pending.promise;
    }
  };
  const modal = new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language: "en",
    copy,
    preflight: service,
    save: async () => ({ saved: true })
  });

  modal.open();
  assert.equal(calls.length, 0, "opening the modal must not request models");
  assertProviderModalStatus(modal, "idle");
  assert.deepEqual(
    Array.from(modal.contentEl.querySelectorAll<HTMLElement>(
      ".codex-provider-model-advanced-heading"
    )).map((heading) => heading.textContent),
    ["Model capabilities", "Context and output"]
  );
  assert.match(
    modal.contentEl.textContent,
    /Per-request output limit/u
  );
  assert.doesNotMatch(
    modal.contentEl.textContent,
    /Actual max output/u
  );
  const primaryModelId = primaryProviderModel(provider).id;
  const primaryModelRow = providerModalElementByFocusKey(
    modal,
    `model-enabled:${primaryModelId}`
  )?.closest<ProviderModalTestElement>(".codex-provider-model-choice");
  assert.ok(primaryModelRow);
  const capabilityTags = primaryModelRow.querySelector(".codex-provider-model-capabilities")!.querySelectorAll<ProviderModalTestElement>(
    ".codex-provider-model-tag"
  );
  assert.equal(capabilityTags.length, 4);
  assert.deepEqual(
    capabilityTags.map((tag) => tag.textContent),
    ["Built-in preset", "text only", "Tool calling", "Deep reasoning supported"]
  );
  assert.doesNotMatch(
    primaryModelRow.querySelector(".codex-provider-model-capabilities")?.textContent ?? "",
    /\s·\s/u
  );
  for (const key of [
    "contextWindow",
    "modelMaxTokens",
    "maxOutputTokens"
  ] as const) {
    const input = providerModalElementByFocusKey(
      modal,
      `model:${primaryModelId}:${key}`
    );
    assert.ok(input);
    assert.equal(input.value, "");
    assert.match(
      input.getAttribute("placeholder") ?? "",
      /^Auto \([\d,]+\)$/u
    );
  }
  const apiKey = providerModalElementByFocusKey(modal, "apiKey");
  assert.ok(apiKey);
  apiKey.value = "replacement-api-key";
  apiKey.oninput?.(new Event("input"));
  assert.equal(calls.length, 0, "editing an API key must not request models");
  const discover = providerModalElementByFocusKey(modal, "model-discover");
  assert.ok(discover);
  discover.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "listModels");
  assert.equal(calls[0]?.draft.providerSettingsId, provider.id);
  assert.equal(calls[0]?.draft.apiKey, "replacement-api-key");
  assertProviderModalStatus(modal, "loading", copy.providers.modelListLoading);

  const nextModel = API_PROVIDER_PRESETS.find(
    (preset) => preset.id === "deepseek"
  )?.models[1]?.id;
  assert.ok(nextModel);
  discovery.resolve({
    status: "available",
    models: [{ id: primaryProviderModel(provider).id }, { id: nextModel }]
  });
  await flushProviderModalTasks();
  assert.deepEqual(
    provider.models.map((model) => model.id),
    [primaryProviderModel(provider).id],
    "refresh results must not silently change enabled models"
  );
  const firstTest = providerModalElementByFocusKey(
    modal,
    "provider-test-connection"
  );
  assert.ok(firstTest);
  firstTest.click();
  assert.equal(calls[1]?.operation, "testConnection");
  assert.equal(calls[1]?.draft.modelId, primaryProviderModel(provider).id);
  assert.equal(calls[1]?.draft.apiKey, "replacement-api-key");
  assertProviderModalStatus(modal, "loading", copy.providers.testingConnection);

  const nextEnabled = providerModalElementByFocusKey(
    modal,
    `model-enabled:${nextModel}`
  );
  assert.ok(nextEnabled);
  nextEnabled.checked = true;
  nextEnabled.onchange?.(new Event("change"));
  const nextDefault = providerModalElementByFocusKey(
    modal,
    `model-default:${nextModel}`
  );
  assert.ok(nextDefault);
  nextDefault.checked = true;
  nextDefault.onchange?.(new Event("change"));
  assertProviderModalStatus(modal, "idle");

  connections[0]?.resolve({ status: "available" });
  await flushProviderModalTasks();
  assertProviderModalStatus(modal, "idle");
  assert.doesNotMatch(
    providerModalStatus(modal).textContent,
    new RegExp(copy.providers.connectionAvailable, "u")
  );

  const secondTest = providerModalElementByFocusKey(
    modal,
    "provider-test-connection"
  );
  assert.ok(secondTest);
  secondTest.click();
  assert.equal(calls[2]?.operation, "testConnection");
  assert.equal(calls[2]?.draft.modelId, nextModel);
  assert.equal(calls[2]?.draft.apiKey, "replacement-api-key");

  const customProvider = modal.contentEl.querySelector<HTMLButtonElement>(
    '[data-provider-id="custom"]'
  );
  assert.ok(customProvider);
  customProvider.click();
  const endpoint = providerModalElementByFocusKey(modal, "endpoint");
  assert.ok(endpoint);

  connections[1]?.resolve({ status: "available" });
  await flushProviderModalTasks();
  assert.equal(providerModalElementByFocusKey(modal, "endpoint"), endpoint);
  assert.deepEqual(
    calls.map((call) => call.operation),
    ["listModels", "testConnection", "testConnection"]
  );
  modal.close();
}

async function assertProviderModelModalCloseCancelsPendingPreflight(): Promise<void> {
  installProviderModalDomFixture();
  const copy = settingsCopy("en");
  const provider = createApiProviderConfig("deepseek", "close-modal-provider");
  provider.apiKey = "close-modal-provider-api-key";
  const first = deferred<PiProviderModelListResult>();
  const reopened = deferred<PiProviderModelListResult>();
  const pending = [first, reopened];
  let attempt = 0;
  const service = {
    listModels: async () => {
      const result = pending[attempt++];
      assert.ok(result);
      return await result.promise;
    },
    testConnection: async (): Promise<PiProviderConnectionTestResult> => ({
      status: "available"
    })
  };
  const createModal = () => new ProviderModelModal({
    app: new App(),
    draft: provider,
    editing: true,
    language: "en",
    copy,
    preflight: service,
    save: async () => ({ saved: true })
  });
  let modal = createModal();
  const closedRequestModel = "closed-request-model";

  modal.open();
  assert.equal(attempt, 0);
  providerModalElementByFocusKey(modal, "model-discover")?.click();
  assert.equal(attempt, 1);
  modal.close();
  first.resolve({ status: "available", models: [{ id: closedRequestModel }] });
  await flushProviderModalTasks();
  assert.equal(modal.contentEl.textContent, "", "a late discovery response cannot rebuild the disposed form");

  // Settings creates a fresh editor for a new open. Closing the previous
  // instance deliberately clears its transient key and its copied draft key.
  modal = createModal();
  modal.open();
  assert.equal(attempt, 1);
  assertProviderModalStatus(modal, "idle");
  providerModalElementByFocusKey(modal, "model-discover")?.click();
  assert.equal(attempt, 2);
  assertProviderModalStatus(modal, "loading", copy.providers.modelListLoading);
  assert.equal(
    Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .some((button) => button.title === closedRequestModel),
    false
  );
  reopened.resolve({
    status: "available",
    models: [{ id: primaryProviderModel(provider).id }]
  });
  await flushProviderModalTasks();
  modal.close();
}

function assertProviderModalStatus(
  modal: ProviderModelModal,
  status: string,
  text?: string
): void {
  const element = providerModalStatus(modal);
  assert.equal(element.hasClass(`is-${status}`), true);
  if (text) assert.match(element.textContent, new RegExp(text, "u"));
}

function providerModalStatus(modal: ProviderModelModal): ProviderModalTestElement {
  const status = modal.contentEl.querySelector(
    ".codex-provider-model-status"
  ) as ProviderModalTestElement | null;
  assert.ok(status);
  return status;
}

function providerModalElementByFocusKey(
  modal: ProviderModelModal,
  focusKey: string
): ProviderModalTestElement | null {
  return modal.contentEl.querySelector(
    `[data-modal-focus-key="${focusKey}"]`
  ) as ProviderModalTestElement | null;
}

function replacementGuidanceAnnouncementCount(modal: ProviderModelModal): number {
  const liveRegion = modal.modalEl.querySelector<ProviderModalTestElement>(
    ".codex-provider-modal-live-region"
  );
  assert.ok(liveRegion);
  return liveRegion.textContentAssignments.filter((message) =>
    /Connection settings changed/u.test(message)
  ).length;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushProviderModalTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

let providerModalTestDocument: ProviderModalTestDocument;


// ---------------------------------------------------------------------------
// Desktop registry identity and shared mobile/avatar controls
// ---------------------------------------------------------------------------


async function assertPersonalMemoryDtoAndRegistryIdentity(): Promise<void> {
  const control = Object.freeze({ agent: "", user: "# USER", memory: "# MEMORY", revision: 3,
    records: Object.freeze([]), forgottenIds: Object.freeze([]) });
  let reads = 0;
  const state = await CodexForObsidianPlugin.prototype.getEchoInkPersonalMemoryState.call({
    ensurePiLocalData: async () => ({ personalMemory: { readUserControlState: async () => { reads++; return control; } } }),
    cognitiveSystem: new Proxy({}, { get() { throw new Error("desktop Memory must not consult legacy Agent state"); } })
  } as never);
  assert.equal(state, control, "the complete user control snapshot is returned without mixing legacy identity reads");
  assert.equal(reads, 1);
  assert.equal(Object.hasOwn(state, "agentIdentity"), false);
  assert.equal(Object.hasOwn(state, "agentProfile"), false);

  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentRegistry.agents.push({ ...structuredClone(settings.agentRegistry.agents[0]), id: "editor", name: "整理员", avatar: { kind: "preset", presetId: "mica" } });
  const host = { settings, cognitiveSystem: new Proxy({}, { get() { throw new Error("desktop identity must use the registry"); } }) };
  const identity = () => CodexForObsidianPlugin.prototype.getEchoInkAgentIdentityView.call(host as never);
  settings.taskWorkspace.page = { kind: "list", agentId: "editor" };
  assert.equal(identity().displayName, "整理员");
  assert.equal(identity().avatarUrl, resolveAgentAvatarUrl({ kind: "preset", presetId: "mica" }));
  settings.agentRegistry.agents[1].name = "最新整理员";
  assert.equal(identity().displayName, "最新整理员", "each read uses the current registry");
  settings.taskWorkspace.page = { kind: "detail", taskId: "saved-task" };
  settings.sessions = [{ id: "saved-task", agentId: "editor" } as never];
  assert.equal(identity().displayName, "最新整理员");
  settings.agentRegistry.agents = settings.agentRegistry.agents.filter(agent => agent.id !== "editor");
  assert.equal(identity().displayName, settings.agentRegistry.agents[0].name, "removed owners fall back to Sol");
  assert.equal(identity().personalityTemplateId, null);
  console.log("PASS settings: user Memory snapshot and current registry identity are independent of legacy Self");
}


function createIdentityFixtureState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return { agent: "", user: "# User", memory: "# Memory", revision: 3,
    records: Object.freeze([]), forgottenIds: Object.freeze([]), ...overrides };
}

function createIdentityTestPlugin(fixtureState: Record<string, any>): {
  plugin: Record<string, any>;
  refreshCalls: () => number;
  personalMemoryCalls: () => number;
} {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "general";
  let refreshes = 0;
  let personalMemoryCalls = 0;
  const plugin: Record<string, any> = {
    app: new App(),
    manifest: { id: "codex-echoink" },
    settings,
    getCognitiveSystem: async () => createCognitiveSystemStub(),
    getCodexView: () => ({ refreshPersonalizationUi: () => { refreshes += 1; } }),
    getEchoInkPersonalMemoryState: async () => {
      personalMemoryCalls += 1;
      return structuredClone(fixtureState);
    }
  };
  return {
    plugin,
    refreshCalls: () => refreshes,
    personalMemoryCalls: () => personalMemoryCalls
  };
}


async function assertManualDreamSettingsUi(): Promise<void> {
  installProviderModalDomFixture();
  const state = createIdentityFixtureState();
  const { plugin } = createIdentityTestPlugin(state);
  plugin.saveSettings = async () => undefined;
  let calls = 0;
  let complete: ((value: any) => void) | undefined;
  let nextResult: any = null;
  let deferred = true;
  const system = { ...createCognitiveSystemStub(), forceDreamRun: async () => {
    calls += 1;
    if (deferred) return await new Promise(resolve => { complete = resolve; });
    if (nextResult instanceof Error) throw nextResult;
    return nextResult;
  } };
  plugin.getCognitiveSystem = async () => system;
  const container = providerModalTestDocument.body.createDiv();
  const memory = new DesktopMemorySettings(plugin as never, { redraw: () => tab.display(), openCorrection() {}, openProfile() {} });
  const tab = {
    containerEl: container,
    display() { container.empty(); memory.render(container as unknown as HTMLElement); },
    hide() { memory.suspend(); container.remove(); }
  };
  const findButton = () => tab.containerEl.querySelectorAll<ProviderModalTestElement>("button")
    .find(button => ["立即做梦", "整理中…", "Dream now", "Consolidating…"].includes(button.textContent));
  const result = { startedAt: 1, finishedAt: 2, processedMemoryIds: ["fixture"], failedMemoryIds: [],
    factsCreated: 1, factsReused: 0, factsRetired: 0, decayed: 0, autoDisabled: 0,
    userUpdated: false, providerUnavailable: false, committed: true, error: null };
  openTestNoticeMessages.length = 0;
  tab.display();
  assert.ok(findButton(), "enabled Dream exposes the normal settings action");
  findButton()!.click();
  findButton()!.click();
  await settleMicrotasks();
  assert.equal(calls, 1, "double click starts exactly one production Dream call");
  tab.display();
  assert.equal(findButton()?.disabled, true, "redrawing settings preserves the running state");
  assert.equal(findButton()?.textContent, "整理中…");
  findButton()!.click();
  assert.equal(calls, 1, "redrawn button cannot dispatch a duplicate run");
  complete!(result);
  await flushProviderModalTasks();
  tab.display();
  assert.equal(findButton()?.disabled, false);
  assert.equal(openTestNoticeMessages.length, 1, "one native Notice reports one run");
  assert.match(openTestNoticeMessages.at(-1)!, /完成|已整理/u);

  deferred = false;
  for (const [value, expected] of [
    [null, /忙|稍后|未运行/u],
    [{ ...result, providerUnavailable: true, committed: false }, /模型|Provider/u],
    [{ ...result, processedMemoryIds: [], factsCreated: 0, committed: false }, /无需|暂无|没有/u],
    [{ ...result, failedMemoryIds: ["failed"] }, /失败|未完成|待重试/u],
    [{ ...result, committed: false, error: "fixture_error" }, /失败|未完成/u],
    [new Error("fixture failure"), /失败|未完成/u]
  ] as const) {
    nextResult = value;
    findButton()!.click();
    await flushProviderModalTasks();
    tab.display();
    assert.match(openTestNoticeMessages.at(-1)!, expected);
    assert.equal(findButton()?.disabled, false, "every result releases the manual action");
  }
  nextResult = { ...result, processedMemoryIds: [], factsCreated: 0, userUpdated: true };
  findButton()!.click();
  await flushProviderModalTasks();
  assert.doesNotMatch(openTestNoticeMessages.at(-1)!, /暂无|无需整理/u,
    "experience-only profile updates are not mislabeled as an empty run");

  plugin.settings.memory.dreamEnabled = false;
  tab.display();
  assert.equal(findButton(), undefined, "disabled Dream hides the manual action");
  plugin.settings.memory.dreamEnabled = true;
  plugin.settings.memory.useLongTermMemory = false;
  tab.display();
  assert.equal(findButton(), undefined, "disabled long-term memory hides the manual action");
  plugin.settings.memory.useLongTermMemory = true;
  plugin.settings.settingsLanguage = "en";
  tab.display();
  assert.equal(findButton()?.textContent, "Dream now");
  tab.hide();
  console.log("PASS manual Dream: production settings entry, deduplication across redraws, outcomes and toggle gates");
}


function assertCustomWelcomeContract(): void {
  const customized = structuredClone(DEFAULT_SETTINGS);
  customized.customWelcomeEnabled = true;
  customized.customWelcomeTitle = "  今天想聊什么？  ";
  customized.customWelcomeSubtitle = "  从一个问题开始。  ";
  const normalized = normalizeSettingsData(customized).settings;
  assert.equal(normalized.customWelcomeEnabled, true);
  assert.equal(normalized.customWelcomeTitle, customized.customWelcomeTitle);
  assert.equal(normalized.customWelcomeSubtitle, customized.customWelcomeSubtitle,
    "mobile welcome configuration survives the shared settings roundtrip");
  const controller = readFileSync("src/ui/codex-view/message-controller.ts", "utf8");
  const list = readFileSync("src/ui/codex-view/message-list.ts", "utf8");
  assert.doesNotMatch(controller, /resolveEchoInkWelcomeCopy|welcomeCopy/u);
  assert.doesNotMatch(list, /welcomeCopy|codex-smooth-ai-suggestions/u);
  console.log("PASS settings: mobile welcome values persist while desktop messages omit the retired empty state");
}

function assertAboutGitHubActionsContract(): void {
  installProviderModalDomFixture();
  const container = providerModalTestDocument.body.createDiv();
  const opened: string[] = [];
  const scope = globalThis as unknown as { require?: (id: string) => unknown };
  const previousRequire = scope.require;
  const previousDesktop = Platform.isDesktopApp;
  const listeners = new Set<() => void>();
  const checks: string[] = [];
  const update = { state: { status: "idle" } as { status: string; version?: string; url?: string },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async check(version: string) { checks.push(version); } };
  Platform.isDesktopApp = true;
  scope.require = id => { assert.equal(id, "electron"); return { shell: { async openExternal(url: string) { opened.push(url); } } }; };
  let dispose = () => {};
  try {
    dispose = renderCompactAbout(container as unknown as HTMLElement, { version: "2.7.0", language: "zh-CN", websiteUrl: "https://echoink.cn/?entry=plugin.about", onLogoClick() {}, update: update as never });
    const actions = container.querySelector<ProviderModalTestElement>(".echoink-about-compact-actions")!.querySelectorAll<ProviderModalTestElement>("button");
    for (const label of ["访问官网", "Star on GitHub", "反馈问题"]) {
      const action = actions.find(button => button.getAttribute("aria-label") === label);
      assert.ok(action, label); action.click();
    }
    assert.deepEqual(opened, ["https://echoink.cn/?entry=plugin.about", "https://github.com/AKin-lvyifang/codex-echoink", "https://github.com/AKin-lvyifang/codex-echoink/issues"]);
    const issue = container.querySelector<ProviderModalTestElement>(".echoink-about-compact-issue")!;
    assert.ok(issue.querySelector(".echoink-about-morph-icon-default"));
    assert.ok(issue.querySelector(".echoink-about-morph-icon-hover"));
    assert.ok(container.querySelector(".echoink-sparkle-icon-default"));
    const check = container.querySelector<ProviderModalTestElement>(".echoink-about-compact-check")!;
    check.click(); assert.deepEqual(checks, ["2.7.0"]);
    update.state = { status: "checking" }; listeners.forEach(listener => listener()); assert.equal(check.disabled, true);
    update.state = { status: "current" }; listeners.forEach(listener => listener()); assert.equal(check.disabled, false);
    assert.match(container.textContent, /已是最新版本/u);
    update.state = { status: "error" }; listeners.forEach(listener => listener()); assert.match(container.textContent, /暂时无法检查，请重试/u);
    assert.equal(container.querySelector(".echoink-about-compact-status")?.getAttribute("aria-live"), "polite");
  } finally { dispose(); container.remove(); Platform.isDesktopApp = previousDesktop; scope.require = previousRequire; }
  assert.equal(listeners.size, 0, "closing About releases the update listener");
  console.log("PASS settings: compact About links, icons, update states and listener cleanup");
}


async function assertIdentityModalNameValidation(): Promise<void> {
  installProviderModalDomFixture();
  let confirmed: { displayName: string } | null = null;
  const modal = new AgentIdentityModal(new App(), {
    initialName: "",
    initialAvatar: { kind: "default" },
    language: "zh",
    mode: "first-run",
    onConfirm: async (draft) => { confirmed = { displayName: draft.displayName }; }
  });
  modal.open();

  const nameInput = findLatestModalElement<ProviderModalTestElement>("name-input");
  const errorEl = modal.contentEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-error"
  );
  const confirm = modal.contentEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-confirm"
  );
  assert.ok(nameInput && errorEl && confirm);

  // Empty name: disabled with visible reason.
  assert.equal((confirm as unknown as { disabled: boolean }).disabled, true);
  assert.match(errorEl!.textContent, /请输入名称/u);

  // Too long (25 Unicode chars): disabled with visible reason.
  (nameInput as unknown as { value: string }).value = "一二三四五六七八九十一二三四五六七八九十一二三四五";
  nameInput!.fireEvent("input");
  assert.equal((confirm as unknown as { disabled: boolean }).disabled, true);
  assert.match(errorEl!.textContent, /不能超过 24/u);

  // Valid CJK + Emoji name: enabled; confirm passes trimmed draft.
  (nameInput as unknown as { value: string }).value = "  小墨🖋️  ";
  nameInput!.fireEvent("input");
  assert.equal((confirm as unknown as { disabled: boolean }).disabled, false);
  assert.equal(errorEl!.textContent, "");
  confirm!.click();
  await settleMicrotasks();
  assert.deepEqual(confirmed, { displayName: "小墨🖋️" });
  console.log("PASS settings: identity modal validates empty/too-long names");
}

async function assertAvatarPresetCatalogBehavior(): Promise<void> {
  installProviderModalDomFixture();
  assert.deepEqual(
    AGENT_AVATAR_PRESETS.map((preset) => preset.labelEn),
    ["Nova", "Rio", "Lin", "Sol", "Mica", "Aya", "Bo", "Cleo", "Dev", "Emi", "Finn", "Gia", "Han", "Ivo", "June"],
    "the shipped catalog keeps the approved fixed order"
  );
  assert.equal(AGENT_AVATAR_PRESETS.length, 15);
  assert.ok(AGENT_AVATAR_PRESETS.every((preset) => preset.assetPath.startsWith("data:image/svg+xml")));

  const modal = new AgentIdentityModal(new App(), {
    initialName: "小墨",
    initialAvatar: { kind: "default" },
    language: "zh",
    mode: "edit",
    onConfirm: async () => undefined
  });
  modal.open();
  assert.match(modal.contentEl.textContent, /给你的 Agent 选一个形象/u);
  assert.ok(modal.contentEl.querySelector(".echoink-agent-identity-upload"));
  assert.equal(modal.contentEl.querySelector(".echoink-agent-identity-modal-preview"), null);
  assert.equal(modal.contentEl.querySelector(".echoink-agent-identity-remove"), null);
  assert.equal(modal.contentEl.querySelectorAll("fieldset").length, 1);
  const options = modal.contentEl.querySelectorAll<ProviderModalTestElement>(".echoink-agent-avatar-option");
  const radios = modal.contentEl.querySelectorAll<ProviderModalTestElement>('input[type="radio"]');
  assert.equal(options.length, 15, "wide picker exposes all 15 preset tiles");
  assert.equal(radios.length, 15, "each tile uses a real radio control");
  assert.equal(radios[0].getAttribute("name"), radios[14].getAttribute("name"));
  assert.equal(radios[0].checked, true, "default identity selects Nova in the draft");
  assert.equal(options[0].hasClass("is-selected"), true);
  assert.ok(options[0].querySelector(".echoink-agent-avatar-option-check"));
  radios[1].focus();
  radios[1].checked = true;
  radios[1].fireEvent("change");
  assert.equal(providerModalTestDocument.activeElement, radios[1], "radio selection preserves keyboard focus");
  assert.deepEqual(modal.currentDraft().avatar, { kind: "preset", presetId: "rio" });
  assert.equal(options[1].hasClass("is-selected"), true);
  assert.equal(options[0].hasClass("is-selected"), false);

  const customDataUrl = "data:image/webp;base64,UkVE";
  const customModal = new AgentIdentityModal(new App(), {
    initialName: "阿澈",
    initialAvatar: {
      kind: "custom",
      mimeType: "image/webp",
      dataUrl: customDataUrl,
      width: 256,
      height: 256
    },
    language: "zh",
    mode: "edit",
    onConfirm: async () => undefined
  });
  customModal.open();
  assert.equal(customModal.contentEl.querySelectorAll(".echoink-agent-avatar-option").length, 16);
  const customTile = customModal.contentEl.querySelector<ProviderModalTestElement>(
    '[data-avatar-value="custom"]'
  );
  assert.ok(customTile?.hasClass("is-selected"), "existing custom avatar is the selected unique custom tile");

  const uploadModal = new AgentIdentityModal(new App(), {
    initialName: "小墨",
    initialAvatar: { kind: "default" },
    language: "zh",
    mode: "edit",
    avatarRenderer: async () => ({ sourceWidth: 256, sourceHeight: 256, dataUrl: customDataUrl }),
    onConfirm: async () => undefined
  });
  uploadModal.open();
  const fileInput = uploadModal.contentEl.querySelector<ProviderModalTestElement>(
    ".echoink-agent-identity-file"
  )!;
  (fileInput as unknown as { files: Blob[] }).files = [
    new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><circle cx="128" cy="128" r="100"/></svg>'], { type: "image/svg+xml" })
  ];
  fileInput.fireEvent("change");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (uploadModal.contentEl.querySelector('[data-avatar-value="custom"]')) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const uploaded = uploadModal.contentEl.querySelector<ProviderModalTestElement>(
    '[data-avatar-value="custom"]'
  );
  assert.ok(
    uploaded?.hasClass("is-selected"),
    `successful upload creates, replaces, and selects one custom tile; error=${uploadModal.contentEl.querySelector(".echoink-agent-avatar-error")?.textContent ?? ""}; draft=${JSON.stringify(uploadModal.currentDraft())}`
  );

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.echoink-agent-avatar-option:focus-within\s*\{[\s\S]*?outline:\s*2px solid/u);
  assert.match(css, /\.echoink-agent-avatar-option\.is-selected \.echoink-agent-avatar-option-check\s*\{[\s\S]*?display:\s*inline-flex/u);

  assert.equal(resolveAgentAvatarPresetAsset("missing"), null);
  assert.equal(resolveAgentAvatarUrl({ kind: "default" }), null);
  assert.equal(resolveAgentAvatarUrl({ kind: "preset", presetId: "missing" }), null);
  assert.equal(resolveAgentAvatarUrl({ kind: "preset", presetId: "nova" }), AGENT_AVATAR_PRESETS[0].assetPath);
  console.log("PASS settings: fixed avatar grid, Nova default, custom tile, and accessible radio semantics");
}

async function assertAvatarProcessorContract(): Promise<void> {
  const smallWebp = "data:image/webp;base64,UkVE";
  const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="200"/></svg>';
  const svgBlob = (source = validSvg) => new Blob([source], { type: "image/svg+xml" });
  const fakeRenderer = (result: { sourceWidth: number; sourceHeight: number; dataUrl: string }) =>
    async () => result;

  assert.equal(validateAvatarSourceType("image/svg+xml"), true);
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", ""]) {
    assert.equal(validateAvatarSourceType(type), false, `must reject ${type}`);
  }
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/png", 10, fakeRenderer({ sourceWidth: 10, sourceHeight: 10, dataUrl: smallWebp })),
    /unsupported_type/u
  );

  assert.equal(validateAvatarSourceSize(AGENT_AVATAR_SOURCE_MAX_BYTES), true);
  assert.equal(validateAvatarSourceSize(AGENT_AVATAR_SOURCE_MAX_BYTES + 1), false);
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/svg+xml", AGENT_AVATAR_SOURCE_MAX_BYTES + 1, fakeRenderer({ sourceWidth: 10, sourceHeight: 10, dataUrl: smallWebp })),
    /source_too_large/u
  );

  assert.deepEqual(validateAgentAvatarSvg(validSvg), { width: 512, height: 512 });
  assert.deepEqual(
    validateAgentAvatarSvg('<svg xmlns="http://www.w3.org/2000/svg" width="256px" height="256px"></svg>'),
    { width: 256, height: 256 }
  );
  await assert.rejects(
    processAgentAvatar(svgBlob('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 256"></svg>'), "image/svg+xml", 100, fakeRenderer({ sourceWidth: 512, sourceHeight: 256, dataUrl: smallWebp })),
    /svg_not_square/u
  );
  await assert.rejects(
    processAgentAvatar(svgBlob('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5000 5000"></svg>'), "image/svg+xml", 100, fakeRenderer({ sourceWidth: 5000, sourceHeight: 5000, dataUrl: smallWebp })),
    /image_too_large/u
  );

  for (const unsafeSvg of [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect onclick="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><use href="#shape"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@import url(https://example.com/a.css)</style></svg>'
  ]) {
    assert.throws(() => validateAgentAvatarSvg(unsafeSvg), /svg_unsafe/u);
  }
  assert.throws(() => validateAgentAvatarSvg("<svg><broken>"), /svg_invalid/u);

  const ok = await processAgentAvatar(
    svgBlob(), "image/svg+xml", 100,
    fakeRenderer({ sourceWidth: 512, sourceHeight: 512, dataUrl: smallWebp })
  );
  assert.equal(ok.kind, "custom");
  assert.equal(ok.mimeType, "image/webp");
  assert.equal(ok.width, 256);
  assert.equal(ok.height, 256);
  assert.equal(ok.dataUrl, smallWebp);

  // JPEG data URL output is invalid (must be re-encoded to webp/png).
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/svg+xml", 100, fakeRenderer({ sourceWidth: 512, sourceHeight: 512, dataUrl: "data:image/jpeg;base64,QUJD" })),
    /output_invalid/u
  );

  // Oversized output Data URL is rejected before persistence.
  const huge = `data:image/webp;base64,${"A".repeat(AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS)}`;
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/svg+xml", 100, fakeRenderer({ sourceWidth: 512, sourceHeight: 512, dataUrl: huge })),
    /output_too_large/u
  );

  // Decode failure surfaces decode_failed, never a raw fallback.
  await assert.rejects(
    processAgentAvatar(svgBlob(), "image/svg+xml", 100, async () => { throw new Error("boom"); }),
    /decode_failed/u
  );

  // The identity JSON only ever contains the processed (small) Data URL,
  // never the raw source bytes.
  const rawMarker = "RAW_SOURCE_BYTES_MUST_NOT_APPEAR";
  const processed = await processAgentAvatar(
    svgBlob(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4096 4096"><text>${rawMarker}</text></svg>`),
    "image/svg+xml",
    AGENT_AVATAR_SOURCE_MAX_BYTES,
    fakeRenderer({ sourceWidth: 4096, sourceHeight: 4096, dataUrl: smallWebp })
  );
  const json = JSON.stringify({
    schema: AGENT_IDENTITY_STATE_SCHEMA,
    revision: 1,
    displayName: "小墨",
    avatar: processed,
    updatedAt: 1
  }, null, 2) + "\n";
  assert.ok(json.length < AGENT_AVATAR_OUTPUT_MAX_DATA_URL_CHARS + 10_000);
  assert.ok(!json.includes(rawMarker));
  console.log("PASS settings: safe square-SVG validation and 256px raster output contract");
}

function findLatestModalElement<T extends ProviderModalTestElement>(selector: string, tab?: CodexSettingTab): T | null {
  if (tab) {
    const inline = tab.containerEl.querySelector(".echoink-settings-inline-content") as unknown as ProviderModalTestElement | null;
    if (!inline) return null;
    return selector === "name-input" ? inline.querySelectorAll<T>("input").find((input) => !input.hasClass("echoink-agent-identity-file")) ?? null : inline.querySelector<T>(selector);
  }
  const modal = openTestModals[openTestModals.length - 1];
  if (!modal) return null;
  const root = modal.contentEl as unknown as ProviderModalTestElement;
  if (selector === "name-input") {
    return root.querySelectorAll<T>("input")
      .find((input) => !input.hasClass("echoink-agent-identity-file")) ?? null;
  }
  return root.querySelector<T>(selector);
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}


async function assertReviewFolderInlineLifecycle(): Promise<void> {
  installProviderModalDomFixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "review";
  let saves = 0;
  const plugin = withSettingsTabDefaults({
    app: { vault: { getAllFolders: () => [{ path: "" }, { path: "outputs" }, { path: "reports/weekly" }] } },
    settings,
    manifest: { id: "codex-echoink" },
    saveSettings: async () => { saves++; }
  });
  const tab = new CodexSettingTab(plugin as never);
  const mutable = tab as any;
  tab.display();
  Object.assign(tab.containerEl, { scrollTop: 900, scrollHeight: 2400, clientHeight: 500 });
  const cancelled = mutable.chooseReviewOutputFolder();
  assert.equal(tab.containerEl.scrollTop, 0, "entering an inline editor resets the native scroll root");
  tab.containerEl.scrollTop = 540;
  tab.containerEl.querySelector<HTMLButtonElement>(".settings-back")!.click();
  await cancelled;
  assert.equal(tab.containerEl.scrollTop, 0, "closing an inline editor resets the native scroll root");
  assert.equal(saves, 0);
  assert.equal(settings.review.outputDir, "outputs");
  const selected = mutable.chooseReviewOutputFolder();
  tab.containerEl.querySelector<HTMLButtonElement>('[data-echoink-focus-key="navigation:reports/weekly"]')!.click();
  await selected;
  assert.equal(saves, 1);
  assert.equal(settings.review.outputDir, "reports/weekly");
  assert.equal(tab.containerEl.querySelector(".echoink-settings-inline-editor"), null);
  tab.hide();
  console.log("PASS settings: inline report folder cancellation is inert and selection persists once");
}

async function assertInlineEditorAsyncRetirement(): Promise<void> {
  installProviderModalDomFixture();
  const draft = createApiProviderConfig("deepseek", "inline-retirement");
  draft.apiKey = "test-placeholder-key";
  let finish!: (value: { saved: true }) => void;
  let saves = 0;
  const pending = new Promise<{ saved: true }>((resolve) => { finish = resolve; });
  const first = new ProviderModelModal({ app: new App(), draft, editing: true, language: "en", copy: settingsCopy("en"), preflight: { listModels: async () => ({ status: "available", models: draft.models }), testConnection: async () => ({ status: "available" }) }, save: async () => { saves++; return await pending; } });
  const firstHost = document.createElement("div");
  let backCalls = 0;
  const disposeFirst = mountSettingsEditor(first, firstHost, "Back", () => { backCalls++; });
  const save = first.contentEl.querySelector<HTMLButtonElement>(".mod-cta")!;
  assert.equal(save.disabled, false);
  save.click(); await settleMicrotasks(); assert.equal(saves, 1);
  disposeFirst();
  const second = new ProviderModelModal({ app: new App(), draft, editing: true, language: "en", copy: settingsCopy("en"), preflight: { listModels: async () => ({ status: "available", models: draft.models }), testConnection: async () => ({ status: "available" }) }, save: async () => ({ saved: true }) });
  const secondHost = document.createElement("div");
  const disposeSecond = mountSettingsEditor(second, secondHost, "Back", () => { backCalls++; });
  const input = second.contentEl.querySelector<HTMLInputElement>('[data-modal-focus-key="name"]')!;
  input.value = "Uncommitted second form";
  finish({ saved: true }); await flushProviderModalTasks();
  assert.equal(backCalls, 0, "a retired form completing must not navigate back");
  assert.equal(input.value, "Uncommitted second form");
  assert.ok(second.contentEl.contains(input), "the newer form remains mounted");
  disposeSecond(); second.close(); second.close();
  assert.equal(backCalls, 0, "hidden/disposed forms never navigate or re-render");
  console.log("PASS settings: pending old save cannot close a newer inline editor");
}

async function runSettingsWindowRefreshTest(): Promise<void> {
  installProviderModalDomFixture();
  const scope = globalThis as unknown as Record<string, unknown>;
  const previousWindow = scope.window;
  const frames = (visibilityState: "visible" | "hidden") => {
    const pending = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let nextId = 0;
    return {
      document: { visibilityState }, pending, cancelled,
      requestAnimationFrame(callback: FrameRequestCallback) {
        pending.set(++nextId, callback);
        return nextId;
      },
      cancelAnimationFrame(id: number) { cancelled.push(id); pending.delete(id); },
      flushVisible() {
        if (visibilityState === "hidden") return;
        const callbacks = [...pending.values()];
        pending.clear();
        callbacks.forEach((callback) => callback(0));
      }
    };
  };
  const mainWindow = frames("hidden");
  const settingsWindow = frames("visible");
  const nextWindow = frames("visible");
  scope.window = mainWindow;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.settingsTab = "general";
  let saves = 0;
  const tab = new CodexSettingTab(withSettingsTabDefaults({
    app: new App(), settings,
    saveSettings: async () => { saves += 1; }
  }) as never);
  const rendered: string[] = [];
  const mutable = tab as unknown as {
    renderSettingsShell(): void;
    renderSettingsContent(): void;
    scheduleDisplay(): void;
    activateSettingsTab(id: "knowledgeBase", focus: boolean): Promise<void>;
  };
  // Keep the real activation/display/hide lifecycle; replace only content
  // rendering so the regression depends on frame ownership, not other pages.
  mutable.renderSettingsShell = () => {};
  mutable.renderSettingsContent = () => { rendered.push(settings.settingsTab); };
  const setOwner = (owner: typeof settingsWindow) => Object.defineProperty(
    tab.containerEl, "ownerDocument", { configurable: true, value: { defaultView: owner, visibilityState: "visible" } }
  );
  setOwner(settingsWindow);
  try {
    tab.display();
    await mutable.activateSettingsTab("knowledgeBase", false);
    mutable.scheduleDisplay();
    assert.equal(saves, 1);
    settingsWindow.flushVisible();
    assert.deepEqual(rendered, ["general", "knowledgeBase"],
      "visible detached settings must refresh while the main window stays hidden");
    assert.equal(mainWindow.pending.size, 0);

    mutable.scheduleDisplay();
    const hiddenFrame = [...settingsWindow.pending.keys()][0]!;
    setOwner(nextWindow);
    tab.hide();
    assert.deepEqual(settingsWindow.cancelled, [hiddenFrame], "hide cancels on the window that scheduled the frame");
    assert.deepEqual(nextWindow.cancelled, []);
    settingsWindow.flushVisible();
    assert.equal(rendered.length, 2, "a cancelled frame must not render after hide");

    tab.display();
    mutable.scheduleDisplay();
    const replacedFrame = [...nextWindow.pending.keys()][0]!;
    setOwner(settingsWindow);
    tab.display();
    assert.deepEqual(nextWindow.cancelled, [replacedFrame], "display cancels the previous window's pending frame");
    nextWindow.flushVisible();
    assert.equal(rendered.length, 4);
    assert.deepEqual(mainWindow.cancelled, []);
  } finally {
    tab.hide();
    scope.window = previousWindow;
  }
}

function installProviderModalDomFixture(): void {
  if (providerModalTestDocument) return;
  providerModalTestDocument = new ProviderModalTestDocument();
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.document = providerModalTestDocument;
  scope.window = globalThis;
  scope.createEl = (tag: string) => providerModalTestDocument.createElement(tag);
  scope.createSvg = (tag: string) => providerModalTestDocument.createElementNS("http://www.w3.org/2000/svg", tag);
  scope.Element = ProviderModalTestElement;
  scope.HTMLElement = ProviderModalTestElement;
  scope.SVGElement = ProviderModalTestSvgElement;
  scope.SVGSVGElement = ProviderModalTestSvgElement;
  scope.DOMParser = ProviderModalTestDomParser;
  scope.MouseEvent = ProviderModalTestMouseEvent;
  scope.innerHeight = 900;
  scope.addEventListener = () => undefined;
  scope.removeEventListener = () => undefined;
  scope.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  scope.cancelAnimationFrame = () => undefined;
  providerModalResizeObservers.length = 0;
  scope.ResizeObserver = ProviderModalTestResizeObserver;
}

const providerModalResizeObservers: ProviderModalTestResizeObserver[] = [];

class ProviderModalTestResizeObserver {
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    providerModalResizeObservers.push(this);
  }
  observe(): void { this.disconnected = false; }
  disconnect(): void { this.disconnected = true; }
  notify(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

class ProviderModalTestMouseEvent {
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown> = {}
  ) {}
}

class ProviderModalTestDocument {
  hasFocus(): boolean { return true; }
  activeElement: ProviderModalTestElement | null = null;
  prefersReducedMotion = false;
  readonly defaultView = {
    getComputedStyle: (element: ProviderModalTestElement) => element.style,
    MouseEvent: ProviderModalTestMouseEvent,
    ResizeObserver: ProviderModalTestResizeObserver,
    HTMLElement: ProviderModalTestElement,
    HTMLDetailsElement: class extends ProviderModalTestElement {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    queueMicrotask: globalThis.queueMicrotask,
    matchMedia: (query: string): MediaQueryList => ({
      media: query,
      matches: query === "(prefers-reduced-motion: reduce)" && this.prefersReducedMotion,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true
    }),
    innerWidth: 1200,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  readonly documentElement = new ProviderModalTestElement("html", this);
  readonly body = new ProviderModalTestElement("body", this);
  querySelectorAll(selector: string): ProviderModalTestElement[] { return this.body.querySelectorAll(selector); }
  private readonly eventListeners = new Map<string, Array<(event: any) => void>>();

  createElement(tagName: string): ProviderModalTestElement {
    return new ProviderModalTestElement(tagName, this);
  }

  createElementNS(namespaceURI: string, tagName: string): ProviderModalTestElement {
    if (namespaceURI === "http://www.w3.org/2000/svg") {
      return new ProviderModalTestSvgElement(this, tagName);
    }
    return new ProviderModalTestElement(tagName, this, namespaceURI);
  }

  importNode(node: ProviderModalTestElement): ProviderModalTestElement {
    if (node instanceof ProviderModalTestSvgElement) {
      return new ProviderModalTestSvgElement(this);
    }
    return new ProviderModalTestElement(node.localName, this);
  }

  addEventListener(type: string, handler: ((event: any) => void) | null): void {
    if (!handler) return;
    const listeners = this.eventListeners.get(type) ?? [];
    listeners.push(handler);
    this.eventListeners.set(type, listeners);
  }

  removeEventListener(type: string, handler: ((event: any) => void) | null): void {
    if (!handler) return;
    const listeners = this.eventListeners.get(type);
    if (!listeners) return;
    const index = listeners.indexOf(handler);
    if (index >= 0) listeners.splice(index, 1);
  }

  fireEvent(type: string, event: Record<string, unknown> = {}): void {
    const synthetic = {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      stopImmediatePropagation: () => undefined,
      ...event
    };
    for (const listener of this.eventListeners.get(type) ?? []) listener(synthetic);
  }
}

class ProviderModalTestDomParser {
  parseFromString(): {
    documentElement: ProviderModalTestSvgElement;
    querySelector: () => null;
  } {
    return {
      documentElement: new ProviderModalTestSvgElement(providerModalTestDocument),
      querySelector: () => null
    };
  }
}

class ProviderModalTestClassList {
  constructor(private readonly element: ProviderModalTestElement) {}

  add(...classes: string[]): void {
    this.element.addClass(...classes);
  }

  remove(...classes: string[]): void {
    this.element.removeClass(...classes);
  }

  contains(className: string): boolean {
    return this.element.hasClass(className);
  }

  toggle(className: string, force?: boolean): boolean {
    const enabled = force ?? !this.contains(className);
    this.element.toggleClass(className, enabled);
    return enabled;
  }
}

class ProviderModalTestStyle {
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }

  removeProperty(name: string): string {
    const previous = this.values.get(name) ?? "";
    this.values.delete(name);
    return previous;
  }
}

class ProviderModalTestElement {
  instanceOf(type: new (...args: any[]) => unknown): boolean { return this instanceof type; }
  readonly children: ProviderModalTestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = new ProviderModalTestClassList(this);
  readonly style = new ProviderModalTestStyle();
  readonly textContentAssignments: string[] = [];
  readonly tagName: string;
  readonly localName: string;
  readonly namespaceURI: string;
  parentElement: ProviderModalTestElement | null = null;
  className = "";
  value = "";
  type = "";
  checked = false;
  disabled = false;
  clientWidth = 0;
  scrollWidth = 0;
  scrollLeft = 0;
  scrollIntoViewCalls = 0;
  title = "";
  href = "";
  onclick: ((event: any) => void) | null = null;
  onchange: ((event?: any) => void) | null = null;
  oninput: ((event?: any) => void) | null = null;
  onkeydown: ((event: any) => void) | null = null;
  private readonly eventListeners = new Map<string, Array<(event: any) => void>>();

  addEventListener(type: string, handler: ((event: any) => void) | null): void {
    if (!handler) return;
    const list = this.eventListeners.get(type) ?? [];
    list.push(handler);
    this.eventListeners.set(type, list);
  }

  removeEventListener(type: string, handler: ((event: any) => void) | null): void {
    const list = this.eventListeners.get(type);
    if (!list || !handler) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  /** Fire both on<type> property handlers and addEventListener handlers. */
  fireEvent(type: string, event: Record<string, unknown> = {}): void {
    const synthetic = {
      target: this,
      currentTarget: this,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      stopImmediatePropagation: () => undefined,
      ...event
    };
    const onHandler = (this as unknown as Record<string, ((e: any) => void) | null>)[`on${type}`];
    onHandler?.(synthetic);
    for (const listener of this.eventListeners.get(type) ?? []) listener(synthetic);
  }
  private readonly attributeValues = new Map<string, string>();
  private ownTextContent = "";
  private connected = true;

  constructor(
    tagName: string,
    readonly ownerDocument: ProviderModalTestDocument,
    namespaceURI = "http://www.w3.org/1999/xhtml"
  ) {
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespaceURI;
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  set id(value: string) {
    this.setAttribute("id", value);
  }

  get textContent(): string {
    return this.ownTextContent
      + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.disconnectChildren();
    this.ownTextContent = String(value ?? "");
    this.textContentAssignments.push(this.ownTextContent);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get attributes(): Array<{ name: string; value: string }> {
    return Array.from(this.attributeValues, ([name, value]) => ({ name, value }));
  }

  prepend(...children: ProviderModalTestElement[]): void {
    for (const child of [...children].reverse()) this.insertBefore(child, this.children[0]);
  }

  append(...children: ProviderModalTestElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child: ProviderModalTestElement): ProviderModalTestElement {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    child.setConnected(this.connected);
    this.children.push(child);
    return child;
  }

  insertBefore(child: ProviderModalTestElement, reference: ProviderModalTestElement): ProviderModalTestElement {
    child.parentElement?.removeChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    child.parentElement = this;
    child.setConnected(this.connected);
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child: ProviderModalTestElement): ProviderModalTestElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    child.setConnected(false);
    return child;
  }

  replaceChildren(...children: ProviderModalTestElement[]): void {
    this.disconnectChildren();
    this.ownTextContent = "";
    this.append(...children);
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  empty(): void {
    this.disconnectChildren();
    this.ownTextContent = "";
  }

  createEl(
    tagName: string,
    options: Record<string, any> = {}
  ): ProviderModalTestElement {
    const child = new ProviderModalTestElement(tagName, this.ownerDocument);
    if (typeof options.cls === "string") child.className = options.cls;
    if (options.text !== undefined) child.textContent = String(options.text);
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      child.setAttribute(name, String(value));
    }
    if (options.value !== undefined) child.value = String(options.value);
    if (options.href !== undefined) {
      child.href = String(options.href);
      child.setAttribute("href", child.href);
    }
    this.appendChild(child);
    return child;
  }

  createDiv(options: Record<string, any> | string = {}): ProviderModalTestElement {
    return this.createEl("div", typeof options === "string" ? { cls: options } : options);
  }

  createSpan(options: Record<string, any> | string = {}): ProviderModalTestElement {
    return this.createEl("span", typeof options === "string" ? { cls: options } : options);
  }

  setText(value: string): void {
    this.textContent = value;
  }

  setCssStyles(styles: Partial<CSSStyleDeclaration>): void {
    for (const [name, value] of Object.entries(styles)) {
      if (value !== undefined && value !== null) {
        this.style.setProperty(name, String(value));
      }
    }
  }

  setCssProps(properties: Record<string, string>): void {
    for (const [name, value] of Object.entries(properties)) {
      this.style.setProperty(name, value);
    }
  }

  addClass(...classes: string[]): void {
    const current = new Set(this.className.split(/\s+/u).filter(Boolean));
    for (const className of classes) current.add(className);
    this.className = Array.from(current).join(" ");
  }

  removeClass(...classes: string[]): void {
    const removed = new Set(classes);
    this.className = this.className
      .split(/\s+/u)
      .filter((className) => className && !removed.has(className))
      .join(" ");
  }

  toggleClass(className: string, enabled: boolean): void {
    if (enabled) this.addClass(className);
    else this.removeClass(className);
  }

  hasClass(className: string): boolean {
    return this.className.split(/\s+/u).includes(className);
  }

  setAttr(name: string, value: string): void {
    this.setAttribute(name, value);
  }

  setAttribute(name: string, value: string): void {
    this.attributeValues.set(name, value);
    if (name === "class") this.className = value;
    if (name === "value") this.value = value;
    if (name === "type") this.type = value;
    if (name === "title") this.title = value;
    if (name === "href") this.href = value;
    if (name.startsWith("data-")) {
      this.dataset[dataAttributeKey(name)] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className || null;
    if (name.startsWith("data-")) return this.dataset[dataAttributeKey(name)] ?? null;
    return this.attributeValues.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributeValues.delete(name);
    if (name === "class") this.className = "";
    if (name.startsWith("data-")) delete this.dataset[dataAttributeKey(name)];
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.attributeValues.has(name);
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return enabled;
  }

  querySelector<T extends ProviderModalTestElement = ProviderModalTestElement>(
    selector: string
  ): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T extends ProviderModalTestElement = ProviderModalTestElement>(
    selector: string
  ): T[] {
    const matches: T[] = [];
    const visit = (element: ProviderModalTestElement): void => {
      for (const child of element.children) {
        if (child.matches(selector)) matches.push(child as T);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchesSimpleSelector(
      this,
      part.trim()
    ));
  }

  closest<T extends ProviderModalTestElement = ProviderModalTestElement>(
    selector: string
  ): T | null {
    let current: ProviderModalTestElement | null = this;
    while (current) {
      if (current.matches(selector)) return current as T;
      current = current.parentElement;
    }
    return null;
  }

  contains(element: ProviderModalTestElement): boolean {
    if (element === this) return true;
    return this.children.some((child) => child.contains(element));
  }

  focus(): void {
    if (this.connected) this.ownerDocument.activeElement = this;
  }

  click(): void {
    this.fireEvent("click");
  }

  dispatchEvent(): boolean {
    return true;
  }

  getBoundingClientRect(): {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  } {
    return { top: 100, bottom: 132, left: 0, right: 240, width: 240, height: 32 };
  }

  scrollIntoView(): void {
    this.scrollIntoViewCalls += 1;
  }

  private disconnectChildren(): void {
    for (const child of this.children) {
      child.parentElement = null;
      child.setConnected(false);
    }
    this.children.length = 0;
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    for (const child of this.children) child.setConnected(connected);
  }
}

class ProviderModalTestSvgElement extends ProviderModalTestElement {
  constructor(ownerDocument: ProviderModalTestDocument, tagName = "svg") {
    super(tagName, ownerDocument, "http://www.w3.org/2000/svg");
  }
}

function matchesSimpleSelector(
  element: ProviderModalTestElement,
  selector: string
): boolean {
  if (!selector) return false;
  const negations = Array.from(selector.matchAll(/:not\(([^)]+)\)/gu));
  for (const negation of negations) {
    if (matchesSimpleSelector(element, negation[1] ?? "")) return false;
  }
  const base = selector.replace(/:not\([^)]+\)/gu, "");
  if (base.includes(":disabled") && !element.disabled) return false;
  const withoutPseudos = base.replace(/:disabled/gu, "");
  const withoutAttributes = withoutPseudos.replace(/\[[^\]]*\]/gu, "");
  const tag = withoutAttributes.match(/^[a-z][a-z0-9-]*/iu)?.[0];
  if (tag && element.localName !== tag.toLowerCase()) return false;
  for (const id of withoutAttributes.matchAll(/#([a-z0-9_-]+)/giu)) {
    if (element.id !== id[1]) return false;
  }
  for (const className of withoutAttributes.matchAll(/\.([a-z0-9_-]+)/giu)) {
    if (!element.hasClass(className[1] ?? "")) return false;
  }
  for (const attribute of withoutPseudos.matchAll(
    /\[([^\]=]+)(?:=["']([^"']*)["'])?\]/gu
  )) {
    const actual = element.getAttribute(attribute[1] ?? "");
    if (actual === null) return false;
    if (attribute[2] !== undefined && actual !== attribute[2]) return false;
  }
  return withoutPseudos === "*" || Boolean(
    tag
    || withoutPseudos.includes("#")
    || withoutPseudos.includes(".")
    || withoutPseudos.includes("[")
  );
}

function dataAttributeKey(name: string): string {
  return name
    .slice(5)
    .replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function withSettingsTabDefaults<T extends object>(plugin: T) {
  const todoReminderService = {
    status: () => ({
      enabled: (plugin as { settings?: typeof DEFAULT_SETTINGS }).settings?.todoReminders?.enabled ?? false,
      permission: "unavailable" as const,
      busy: false,
      error: "" as const
    }),
    subscribe: () => () => undefined,
    setEnabled: async () => ({ ok: false, error: "unavailable" as const }),
    testNotification: async () => ({ ok: false, error: "unavailable" as const })
  };
  return {
    register: () => undefined,
    getKnowledgeSurfaceService: () => null,
    consumeKnowledgeLinkingFocus: () => false,
    consumeKnowledgeLinkingTaskId: () => null,
    applyAppearanceTheme: () => undefined,
    onConversationCatalogChanged: () => () => undefined,
    getEchoInkKnowledgeInitializationState: async () => null,
    getEchoInkKnowledgeBaseStructure: async () =>
      makeKnowledgeBaseStructureFixture("uninitialized"),
    restoreEchoInkKnowledgeBaseStructure: async () => ({
      structure: makeKnowledgeBaseStructureFixture("ready"),
      createdRoots: [...KNOWLEDGE_INITIALIZATION_ROOTS]
    }),
    isEchoInkOnboardingRequested: () => false,
    getEchoInkOnboardingStep: () => "provider" as const,
    advanceEchoInkOnboarding: async () => null,
    dismissEchoInkOnboarding: async () => undefined,
    getQuickChatWindowController: () => null,
    applyQuickChatSettings: () => ({ ok: false, reason: "unavailable" as const }),
    returnQuickChatToSidebar: async () => undefined,
    toggleQuickChatWindow: async () => undefined,
    getTodoReminderService: () => todoReminderService,
    getTodoStore: () => ({
      completionStatistics: () => todoCompletionStatistics({}),
      subscribe: () => () => undefined,
      snapshot: () => [],
      openSourceFile: async () => undefined,
      renameCategoryInSource: async () => undefined,
      removeCategoryFromSource: async () => undefined
    }),
    ...plugin
  };
}


Platform.isDesktopApp = false;
if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "provider-output-limit") {
  await assertProviderOutputLimitContract();
  await assertQwenTokenPlanTransportContract();
  console.log("PASS output limit: existing Qwen transport, history and failure contracts");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "provider-retry") {
  await assertPiAgentSessionPartialAwareRetryContract();
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "settings-save-resilience") {
  await runSettingsSaveResilienceTests();
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "p16-settings") {
  await assertKnowledgeSettingsDetailRetiresLegacyControls();
  await assertKnowledgeInitNotePickerModalContract();
  await assertPersonalMemoryDtoAndRegistryIdentity();
  assertCustomWelcomeContract();
  await assertIdentityModalNameValidation();
  await assertAvatarPresetCatalogBehavior();
  await assertAvatarProcessorContract();
  console.log("PASS P16 production Knowledge preferences, registry identity, shared mobile fields and avatar controls");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "settings-model-finish") {
  await assertDesktopModelAndMcpFinish();
  await assertDesktopDemoResourceGroupsPreserveSearch();
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "settings-demo-align") {
  await assertDesktopDemoResourceGroupsPreserveSearch();
  await assertSettingsRouteTargetsHostCopy();
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "p11-settings") {
  await assertProviderActivationMainTransactionContract();
  await assertPersistedProviderRollbackPreservesQueuedSettingsSave();
  console.log("PASS P11 Provider activation transaction and persisted rollback preserve queued unrelated settings saves");
  await assertSettingsDeleteFailuresKeepAuthoritativeRows();
  await assertSettingsRouteTargetsHostCopy();
  await assertOnboardingResumeSettingsRoute();
  await assertAnimatedSettingsTabIcons();
  await assertSettingsAccessibleNamesAndOverflow();
  await assertMcpPanelUsesTurnResourceTruth();
  await assertBuiltinSkillEditorLifecycle();
  await assertSkillToggleNotCommittedRestoresAuthoritativeUi();
  await assertKnowledgeSettingsDetailRetiresLegacyControls();
  await assertMcpModalFieldAccessibility();
  await assertInlineEditorAsyncRetirement();
  await assertProviderLimitOverrideRoundTrip();
  await runSettingsWindowRefreshTest();
  console.log("PASS P11 desktop settings compatibility: navigation/icons/focus, resources/permission truth, full Provider/MCP fields and detached window");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "manual-dream") {
  await assertManualDreamSettingsUi();
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "usage") {
  await assertUsageGenerationWiring();
  await assertAnthropicDocumentTransportContract();
  console.log("PASS usage wiring: background generation, connection check, actual dispatch, PDF fallback and tool continuation");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "provider-discovery-related") {
  assertProviderModelReasoningOverrideBoundary();
  await runHarnessV2PiObsidianSecretStorageTests();
  await runHarnessV2PiProviderSecurityTests();
  await runPiNativeControlledProviderTests();
  assertSettingsV53MigrationContract();
  assertPiReasoningCapabilityContract();
  assertKnowledgeMaintenanceSubmitSnapshotContract();
  await assertPiReasoningPayloadContract();
  assertProviderScopedRollbackPreservesConcurrentSettings();
  await assertProviderApiKeyPersistenceLifecycle();
  await runApiProviderActivationServiceTests();
  await assertProviderActivationMainTransactionContract();
  assertAllOpenComposersSynchronizeAfterActivation();
  await assertProviderTextGenerationCompletionContract();
  await assertCodexConnectionTestContract();
  assertPresetRequestMappings();
  assertAnthropicProviderContract();
  assertQwenProviderContract();
  await assertQwenTokenPlanTransportContract();
  await assertPiAgentSessionPartialAwareRetryContract();
  await assertProviderModelDiscoveryRequestContract();
  assertCustomProtocolContract();
  assertOpenAICodexSseAdapterContract();
  await assertProviderRequestLimitDispatchContract();
  await assertProtocolPayloadLimitContract();
  await assertSpecialProviderPayloadLimitContract();
  await assertAnthropicDocumentTransportContract();
  await assertProviderAuthResolutionFailureContract();
  assertSavedModelLifecycle();
  await assertProviderLimitOverrideRoundTrip();
  await assertProviderModelModalPreflightLifecycle();
  await assertProviderApiKeyEditLifecycle();
  await assertProviderModalModelAccessibleNameIncludesValue();
  await assertProviderModelModalCloseCancelsPendingPreflight();
  await assertFreshCustomModelDiscoveryLifecycle();
  await runProviderModelDiscoveryRegression(installProviderModalDomFixture);
  console.log("PASS relevant Provider settings, activation, limits, reasoning, request/failure/partial and dynamic discovery regressions");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "custom-tool-calling") {
  await runCustomModelToolCallingTests();
  await runCustomToolCallingRuntimeTests();
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "dynamic-discovery") {
  await runProviderModelDiscoveryRegression(installProviderModalDomFixture);
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "english-diary") {
  await runEnglishDiaryProviderTests(installProviderModalDomFixture);
  console.log("PASS English Diary saved Provider selection, rollback, credential reuse and recipient consent");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "codex-connection") {
  await assertCodexConnectionTestContract();
  await assertProviderAuthResolutionFailureContract();
  console.log("PASS Codex connection timeout, low reasoning, complete answers and safe auth failures");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "archive-placement") {
  await assertSettingsAccessibleNamesAndOverflow();
  console.log("PASS automatic archive appears only in Review before archived conversations, with unchanged options/default");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "document-transport") {
  await assertAnthropicDocumentTransportContract();
  console.log("PASS native PDF rejection -> frozen text fallback and tool continuation; non-fallback failures remain failures");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "visual") {
  throw new Error("The legacy settings visual fixture was retired. Use the current desktop settings DOM fixtures or native acceptance.");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "onboarding-candidate") {
  assertOnboardingTruthContract();
  assertFiveStepOnboardingEntrypoints();
  await assertOnboardingCoachmarkAccessibilityContract();
  await assertOnboardingDoesNotLockSettingsNavigation();
  await assertOnboardingNavigationPersistence();
  await assertOnboardingTargetSaveFailure();
  await assertOnboardingPersonalityHostRebuild();
  await assertOnboardingResumeSettingsRoute();
  await assertOnboardingColleagueSubmitDelegation();
  console.log("PASS affected onboarding navigation, completion, persistence and window lifecycle");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "inline") {
  await assertInlineEditorAsyncRetirement();
  await assertReviewFolderInlineLifecycle();
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "layout-candidate") {
  await assertProviderPickerGroupingAndFiltering();
  await assertProviderLimitOverrideRoundTrip();
  await assertProviderModelModalPreflightLifecycle();
  await assertProviderApiKeyEditLifecycle();
  await assertProviderModalModelAccessibleNameIncludesValue();
  await assertProviderModelModalCloseCancelsPendingPreflight();
  await assertInlineEditorAsyncRetirement();
  await runSettingsWindowRefreshTest();
  console.log("PASS affected settings shell, Provider editor and inline lifecycle");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "pages-candidate") {
  await assertBuiltinSkillEditorLifecycle();
  await assertSkillToggleNotCommittedRestoresAuthoritativeUi();
  await assertMcpModalFieldAccessibility();
  await assertSettingsAccessibleNamesAndOverflow();
  await assertMcpPanelUsesTurnResourceTruth();
  await assertKnowledgeSettingsDetailRetiresLegacyControls();
  await assertMemoryCorrectionModalContract();
  await assertReviewFolderInlineLifecycle();
  await assertFreshCustomModelDiscoveryLifecycle();
  await assertProviderLimitOverrideRoundTrip();
  console.log("PASS affected settings pages, editors and existing action lifecycles");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "knowledge-ui-candidate") {
  await assertKnowledgeMaintenanceSubmitSnapshotContract();
  await assertKnowledgeInitNotePickerModalContract();
  await assertKnowledgeSettingsDetailRetiresLegacyControls();
  console.log("PASS production Knowledge preferences, submit snapshot and shared note picker; directory transactions use the module-folder suites");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "spacing-candidate") {
  await assertSettingsAccessibleNamesAndOverflow();
  await assertSkillToggleNotCommittedRestoresAuthoritativeUi();
  console.log("PASS settings resize/focus and resource list behavior; style fixtures written");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "directory-style-candidate") {
  await assertKnowledgeInitNotePickerModalContract();
  console.log("PASS shared note picker filtering, assignment, cancellation and retry; current directory UI uses the module-folder suites");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "resource-style-candidate") {
  await assertSkillToggleNotCommittedRestoresAuthoritativeUi();
  console.log("PASS resource filter action lifecycle; browser style fixtures written to .tmp/settings-style-*.html");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "knowledge-style-candidate") {
  throw new Error("The old ten-directory initialization style fixture was retired. Use the current module-folder settings suite.");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "settings-window") {
  await runSettingsWindowRefreshTest();
  console.log("PASS detached settings refresh and cancellation with hidden main window");
} else if (process.env.ECHOINK_PROVIDER_SETTINGS_CASE === "builtin-skill") {
  await runBuiltinSkillSettingsBehaviorTests();
} else {
  await runCustomModelToolCallingTests();
  await runCustomToolCallingRuntimeTests();
  await runProviderSettingsBehaviorTests();
}
