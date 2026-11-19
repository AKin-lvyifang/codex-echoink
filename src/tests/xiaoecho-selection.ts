import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Platform } from "obsidian";
import { createApiProviderConfig, createApiProviderModelConfig, DEFAULT_SETTINGS, setEchoInkAccountCredentialProbe, type CodexForObsidianSettings } from "../settings/settings";
import { publishXiaoechoCatalogChanges, rejectXiaoechoModel, subscribeXiaoechoCatalogChanges } from "../membership/xiaoecho-catalog-state";
import { composerProviderModelOptions, currentComposerModelName, currentComposerSummaryTitle, repairComposerXiaoechoSelection } from "../ui/codex-view/composer-controller";
import { renderComposerToolbar } from "../ui/codex-view/composer";
import { createQueuedTurnFromComposer, frozenTurnReasoningSelectionIsValid, repairQueuedXiaoechoModelSelection } from "../ui/codex-view/turn-runner";
import { closeComposerParameterMenu, openModelMenu, reanchorComposerParameterMenu, type ModelMenuState } from "../ui/codex-view/menus";
import { CodexView } from "../ui/codex-view";
import type { TurnOptions } from "../ui/turn-options";
import { ConversationRunService } from "../plugin/conversation-run-service";
import { installComposerMenuDomHelpers } from "./composer-menu-dom-host";
import { installMockObsidianDom } from "./obsidian-dom";
import { displayedTooltipsForTests } from "./obsidian-shim";

function fixture(suffix: string): CodexForObsidianSettings {
  const provider = createApiProviderConfig("xiaoecho", `selection-${suffix}`);
  provider.baseUrl = `https://selection-${suffix}.invalid/v1`;
  provider.models = ["auto", "retired", "available"].map(id => createApiProviderModelConfig("xiaoecho", id, provider.runtimeProviderId));
  provider.defaultModelId = "auto";
  const other = createApiProviderConfig("custom", "custom-selection");
  other.baseUrl = "https://custom-selection.invalid/v1";
  other.apiKey = "fixture-key";
  other.models = [createApiProviderModelConfig("custom", "retired", other.runtimeProviderId)];
  other.defaultModelId = "retired";
  return { ...structuredClone(DEFAULT_SETTINGS), apiProviders: [provider, other], activeApiProviderId: provider.id, defaultModel: "retired" };
}

function turnOptions(settings: CodexForObsidianSettings): TurnOptions {
  const provider = settings.apiProviders[0]!;
  return { providerSettingsId: provider.id, runtimeProviderId: provider.runtimeProviderId, model: "retired", reasoning: "high", mode: "agent", permission: "workspace-write", mcpEnabled: false };
}

export async function runXiaoechoSelectionTests(): Promise<void> {
  const dom = new JSDOM("<!doctype html><body><main id=fixture></main>", { pretendToBeVisual: true, url: "http://localhost/" });
  const owner = dom.window.document as unknown as Document;
  const names = ["window", "document", "HTMLElement", "Node", "MutationObserver"] as const;
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  names.forEach(name => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? dom.window : name === "document" ? owner : dom.window[name] }));
  installMockObsidianDom(owner);
  installComposerMenuDomHelpers(owner);
  setEchoInkAccountCredentialProbe(() => true);
  try {
    const settings = fixture("repair");
    const provider = settings.apiProviders[0]!;
    const queued = { turnOptions: turnOptions(settings) };
    const accepted = { turnOptions: turnOptions(settings), piUserEntryAccepted: true };
    const acceptedBefore = structuredClone(accepted);
    rejectXiaoechoModel(provider.baseUrl, "retired");
    const host = { plugin: { settings }, selectedProviderSettingsId: provider.id, selectedModel: "retired" };
    assert.equal(repairComposerXiaoechoSelection(host as never), true);
    assert.equal(host.selectedModel, "auto", "the current unsent selection falls back to Auto");
    assert.equal(repairComposerXiaoechoSelection(host as never), false, "the repair is idempotent");
    host.selectedModel = "available";
    assert.equal(repairComposerXiaoechoSelection(host as never), false, "a later valid user selection is retained");
    host.selectedProviderSettingsId = "custom-selection"; host.selectedModel = "retired";
    assert.equal(repairComposerXiaoechoSelection(host as never), false, "another Provider is untouched");
    assert.deepEqual(composerProviderModelOptions(host as never).filter(value => value.providerSettingsId === provider.id).map(value => value.modelId), ["auto", "available"]);
    assert.ok(composerProviderModelOptions(host as never).some(value => value.providerSettingsId === "custom-selection" && value.modelId === "retired"));
    assert.equal(repairQueuedXiaoechoModelSelection(settings, queued), true);
    assert.equal(queued.turnOptions.model, "auto");
    assert.equal(queued.turnOptions.reasoning, "none", "the old model's reasoning is not carried to Auto");
    assert.ok(frozenTurnReasoningSelectionIsValid(settings, queued.turnOptions));
    assert.equal(repairQueuedXiaoechoModelSelection(settings, accepted), false);
    assert.deepEqual(accepted, acceptedBefore, "an accepted request keeps its captured model and reasoning");

    assertDraftRestore(owner, settings);
    await assertComposerPreparationRace(owner);
    await assertResumeBeforeProviderResolution();
    await assertOpenMenuRefresh(owner);
    assertTypicalPointsPresentation(owner);
    console.log("PASS xiaoecho selection: shared filtering, current/draft repair, prepare race, queued reasoning, accepted isolation, live menu focus and cleanup, desktop points/name separation and mobile isolation");
  } finally {
    setEchoInkAccountCredentialProbe(() => false);
    closeComposerParameterMenu();
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
    dom.window.close();
  }
}

function assertTypicalPointsPresentation(owner: Document): void {
  const settings = fixture("points");
  const provider = settings.apiProviders[0]!;
  provider.models[0]!.displayName = "auto ×0.5";
  provider.models[0]!.discovery = { id: "auto", typicalPoints: "0.15" };
  provider.models[1]!.displayName = "Unavailable price ×1.5";
  provider.models[2]!.displayName = "Available model ×2.8";
  provider.models[2]!.discovery = { id: "available", typicalPoints: "1.25" };
  const customModel = settings.apiProviders[1]!.models[0]!;
  customModel.displayName = "Custom ×7.5";
  customModel.discovery = { id: customModel.id, typicalPoints: "4.5" };
  const host = {
    plugin: { settings }, selectedProviderSettingsId: provider.id, selectedModel: "available",
    effectiveModel: () => host.selectedModel
  };
  const container = owner.querySelector<HTMLElement>("#fixture")!;
  const toolbar = owner.createElement("div");
  const workspace = owner.createElement("div");
  container.append(toolbar, workspace);
  Object.assign(owner.defaultView!.HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); }
  });
  const originalDesktop = Platform.isDesktopApp;
  try {
    for (const language of ["zh-CN", "en"] as const) {
      Platform.isDesktopApp = true;
      settings.settingsLanguage = language;
      const options = composerProviderModelOptions(host as never);
      assert.equal(options.find(value => value.modelId === "auto")!.modelName, "auto");
      assert.equal(options.find(value => value.modelId === "available")!.modelName, "Available model");
      const custom = options.find(value => value.providerSettingsId === "custom-selection")!;
      assert.equal(custom.modelName, "Custom ×7.5", "custom Provider names retain their literal multiplier-like suffix");
      assert.equal(custom.typicalPointsLabel, undefined, "another Provider never receives Xiaoecho points");
      const modelName = currentComposerModelName(host as never);
      const summaryTitle = currentComposerSummaryTitle(host as never);
      assert.equal(modelName, "Available model");
      assert.equal(summaryTitle, modelName, "desktop Xiaoecho's collapsed tooltip contains only the model name");
      renderComposerToolbar(toolbar, workspace, {
        language, session: { id: "points-fixture" } as never,
        knowledgeTaskRunning: false, selectedSkill: null, selectedPermission: "workspace-write", selectedMode: "agent",
        running: false, promptEnhancerRunning: false, hasDraft: false, hasTextDraft: false, hasQueuedItems: false,
        currentComposerModel: modelName, currentComposerProviderBrand: "xiaoecho", currentComposerSummaryTitle: summaryTitle,
        workspacePath: "", workspaceDisplayName: "", workspaceValid: true, contextPanelOpen: false
      }, {} as never);
      const anchor = toolbar.querySelector<HTMLButtonElement>(".codex-model-summary-button")!;
      assert.equal(anchor.querySelector(".codex-composer-model-name")!.textContent, "Available model");
      assert.equal(anchor.querySelector(".codex-parameter-option-points"), null);
      anchor.focus();
      assert.equal(displayedTooltipsForTests.get(anchor), "Available model", "the actual collapsed button tooltip receives the clean name");
      const state: ModelMenuState = {
        language, providerModels: options, selectedProviderSettingsId: provider.id, selectedModel: "available", selectedReasoning: null,
        reasoningCurrentValue: "Off", reasoningDisabledReason: "", reasoningAdjustable: false, reasoningOptions: [], selectedMode: "agent"
      };
      anchor.onclick = event => openModelMenu(event, state, { onSelectModel() {}, onSelectMode() {}, onSelectReasoning() {} });
      anchor.click();
      const root = owner.querySelector<HTMLElement>(".codex-composer-parameter-menu")!;
      assert.equal(root.querySelector(".codex-parameter-menu-value")!.textContent, "Available model", "the root summary excludes points");
      root.querySelector<HTMLButtonElement>("button")!.click();
      const submenu = owner.querySelector<HTMLElement>(".codex-composer-parameter-submenu")!;
      const auto = submenu.querySelector<HTMLButtonElement>('[data-parameter-value="auto"]')!;
      assert.equal(auto.querySelector(".codex-parameter-option-label")!.textContent, "auto");
      assert.equal(auto.querySelector(".codex-parameter-option-points")!.textContent, language === "en" ? "~0.15 pts/msg" : "约 0.15 点/次");
      const available = submenu.querySelector<HTMLButtonElement>('[data-parameter-value="available"]')!;
      assert.equal(available.querySelector(".codex-parameter-option-label")!.textContent, "Available model");
      assert.equal(available.querySelector(".codex-parameter-option-points")!.textContent, language === "en" ? "~1.3 pts/msg" : "约 1.3 点/次");
      available.focus();
      assert.equal(displayedTooltipsForTests.get(available), "Available model", "expanded option tooltips exclude points");
      const missing = submenu.querySelector<HTMLButtonElement>(`[data-parameter-provider="${provider.id}"][data-parameter-value="retired"]`)!;
      assert.ok(missing.classList.contains("is-xiaoecho-model"), "a missing price retains desktop Xiaoecho wrapping");
      assert.equal(missing.querySelector(".codex-parameter-option-points"), null, "a missing server field does not invent a price");
      const customButton = submenu.querySelector<HTMLButtonElement>('[data-parameter-provider="custom-selection"]')!;
      assert.equal(customButton.querySelector(".codex-parameter-option-label")!.textContent, "Custom ×7.5");
      assert.equal(customButton.classList.contains("is-xiaoecho-model"), false);
      assert.equal(customButton.querySelector(".codex-parameter-option-points"), null);
      closeComposerParameterMenu();
      host.selectedModel = "auto";
      assert.equal(currentComposerModelName(host as never), "auto");
      assert.equal(currentComposerSummaryTitle(host as never), "auto");
      host.selectedModel = "available";

      Platform.isDesktopApp = false;
      const mobileOptions = composerProviderModelOptions(host as never);
      assert.equal(mobileOptions.find(value => value.modelId === "available")!.modelName, "Available model ×2.8");
      assert.ok(mobileOptions.every(value => !value.typicalPointsLabel && !value.isXiaoechoModel));
      assert.equal(currentComposerModelName(host as never), "available", "mobile retains its existing selected model source");
      anchor.onclick = event => openModelMenu(event, { ...state, providerModels: mobileOptions }, { onSelectModel() {}, onSelectMode() {}, onSelectReasoning() {} });
      anchor.click();
      owner.querySelector<HTMLElement>(".codex-composer-parameter-menu")!.querySelector<HTMLButtonElement>("button")!.click();
      assert.equal(owner.querySelector(".codex-parameter-option-points"), null, "mobile menus do not display points");
      assert.equal(owner.querySelector(".codex-parameter-option.is-xiaoecho-model"), null, "mobile keeps its previous layout");
      closeComposerParameterMenu();
    }
  } finally {
    Platform.isDesktopApp = originalDesktop;
    closeComposerParameterMenu();
    toolbar.remove(); workspace.remove();
  }
}

async function assertResumeBeforeProviderResolution(): Promise<void> {
  const settings = fixture("resume");
  const session = { id: "resume-fixture", agentId: "fixture-agent", title: "", cwd: "/fixture", messages: [], createdAt: 0, updatedAt: 0 };
  settings.sessions = [session];
  let resolvedModel = "";
  const plugin = {
    settings, saveSettings: async () => undefined,
    prepareTaskResume: async (_id: string, _message: string, item: { turnOptions: TurnOptions }) => {
      resolvedModel = item.turnOptions.model;
      assert.equal(item.turnOptions.reasoning, "none");
      throw new Error("selection_fixture_stop_before_provider_resolution");
    }
  };
  const service = new ConversationRunService(plugin as never);
  rejectXiaoechoModel(settings.apiProviders[0]!.baseUrl, "retired");
  await assert.rejects(service.resumeTask(session.id, "继续", {
    id: "resume-queued", sessionId: session.id, text: "继续", attachments: [], skill: null,
    turnOptions: turnOptions(settings), kind: "chat", createdAt: 0
  }, "queue"), /selection_fixture_stop_before_provider_resolution/u);
  assert.equal(resolvedModel, "auto", "resume repairs the cloned queue item before provider resolution");
  await service.flushSave();
}

function assertDraftRestore(owner: Document, settings: CodexForObsidianSettings): void {
  const input = owner.createElement("textarea");
  let saved: any;
  const view = Object.create(CodexView.prototype) as any;
  Object.assign(view, {
    plugin: { settings, getConversationRunService: () => ({ scheduleSave() {} }) },
    inputEl: input, taskUiMounted: true, composerSessionDrafts: new Map(), taskInterruptions: new Map(),
    taskNav: { draftKey: "agent:fixture", page: { kind: "list", agentId: "fixture" },
      draft: () => ({ text: "保留草稿正文", attachments: [], selectedProviderSettingsId: settings.activeApiProviderId, selectedModel: "retired" }),
      save: (draft: unknown) => { saved = draft; } },
    renderAttachments() {}, renderToolbar() {}, updateInputPlaceholder() {}
  });
  view.restoreTaskComposerDraft();
  assert.equal(view.selectedModel, "auto");
  assert.equal(input.value, "保留草稿正文");
  assert.equal(saved.selectedModel, "auto", "restored stale selection is saved back to its draft");
  assert.equal(saved.text, "保留草稿正文");
}

async function assertComposerPreparationRace(owner: Document): Promise<void> {
  const settings = fixture("prepare");
  const input = owner.createElement("textarea"); input.value = "等待准备时保留正文";
  let finishWorkspace!: (ready: boolean) => void;
  const workspace = new Promise<boolean>(resolve => { finishWorkspace = resolve; });
  const session = { id: "fixture-conversation", cwd: "/fixture", messages: [] };
  const host = {
    plugin: { settings }, app: {}, inputEl: input, attachments: [], selectedSkill: null,
    ensureSession: () => session, currentTurnOptions: () => turnOptions(settings),
    ensureChatWorkspaceSelected: () => workspace
  };
  const preparing = createQueuedTurnFromComposer(host as never, { allowLocalKnowledgeCommands: false });
  rejectXiaoechoModel(settings.apiProviders[0]!.baseUrl, "retired");
  finishWorkspace(true);
  const prepared = await preparing;
  assert.ok(prepared, "catalog replacement during preparation does not reject an otherwise valid draft");
  assert.equal(prepared.turnOptions.model, "auto");
  assert.equal(prepared.turnOptions.reasoning, "none");
  assert.equal(prepared.text, input.value);
}

async function assertOpenMenuRefresh(owner: Document): Promise<void> {
  const container = owner.querySelector<HTMLElement>("#fixture")!;
  const input = owner.createElement("textarea"); input.value = "正在编辑的内容"; input.setSelectionRange(2, 4);
  let anchor = owner.createElement("button"); container.append(anchor, input);
  let state: ModelMenuState = {
    language: "zh-CN", selectedProviderSettingsId: "fixture", selectedModel: "retired", selectedReasoning: null,
    reasoningCurrentValue: "关闭", reasoningDisabledReason: "", reasoningAdjustable: false, reasoningOptions: [], selectedMode: "agent",
    providerModels: ["auto", "retired", "available"].map(id => ({ providerSettingsId: "fixture", providerName: "小echo", modelId: id, modelName: id }))
  };
  let subscriptions = 0;
  const selected: string[] = [];
  anchor.onclick = event => openModelMenu(event, { ...state, readCurrent: () => state, subscribeChanges: listener => {
    subscriptions += 1;
    const unsubscribe = subscribeXiaoechoCatalogChanges(listener);
    return () => { subscriptions -= 1; unsubscribe(); };
  } }, { onSelectModel: value => selected.push(value.modelId), onSelectMode() {}, onSelectReasoning() {} });
  anchor.click();
  const root = owner.querySelector<HTMLElement>(".codex-composer-parameter-menu")!;
  root.querySelector<HTMLButtonElement>("button")!.click();
  const before = owner.querySelector<HTMLElement>(".codex-composer-parameter-submenu")!;
  before.querySelectorAll<HTMLButtonElement>("button")[2]!.focus();
  const nextAnchor = owner.createElement("button"); anchor.replaceWith(nextAnchor);
  reanchorComposerParameterMenu(anchor, nextAnchor); anchor = nextAnchor;
  state = { ...state, selectedModel: "auto", providerModels: state.providerModels.filter(value => value.modelId !== "retired") };
  publishXiaoechoCatalogChanges();
  await Promise.resolve();
  const after = owner.querySelector<HTMLElement>(".codex-composer-parameter-submenu")!;
  assert.equal(owner.querySelector(".codex-composer-parameter-menu"), root, "refresh keeps the open root menu");
  assert.ok(after, "the expanded model submenu stays expanded after toolbar replacement");
  assert.deepEqual(Array.from(after.querySelectorAll<HTMLButtonElement>("button")).map(button => button.dataset.parameterValue), ["auto", "available"]);
  assert.equal((owner.activeElement as HTMLElement).dataset.parameterValue, "available", "focus follows the same retained model");
  assert.equal(anchor.getAttribute("aria-expanded"), "true");
  assert.equal(input.value, "正在编辑的内容"); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 4);
  assert.deepEqual(selected, [], "a catalog refresh never submits a selection");
  // A removed focused model falls back to the current Auto option.
  state = { ...state, selectedModel: "available" };
  publishXiaoechoCatalogChanges();
  state = { ...state, selectedModel: "auto", providerModels: state.providerModels.filter(value => value.modelId !== "available") };
  publishXiaoechoCatalogChanges();
  assert.equal((owner.activeElement as HTMLElement).dataset.parameterValue, "auto");
  closeComposerParameterMenu();
  assert.equal(subscriptions, 0, "closing releases the refresh subscription");
  assert.equal(anchor.getAttribute("aria-expanded"), "false");
  assert.equal(owner.querySelector(".codex-composer-parameter-submenu"), null);
}
