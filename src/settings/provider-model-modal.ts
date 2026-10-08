import { providerFailureDetailText } from "../harness/pi/provider-failure";
import { createOriginInput, createOriginButton, createOriginCheck, createOriginSwitch, createOriginSelect, createOriginRadioGroup, disposeOriginControls } from "./origin-controls";
import { App, Modal, setIcon, setTooltip } from "obsidian";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt
} from "@earendil-works/pi-ai";
import type {
  PiProviderConfigurationDraft
} from "../plugin/pi-provider-configuration-service";
import type {
  OpenAICodexAuthStatus
} from "../plugin/openai-codex-oauth-service";
import {
  applyApiProviderModelLimitsOverride,
  apiProviderModelSupportsImage,
  createApiProviderConfig,
  createApiProviderModelConfig,
  createDiscoveredApiProviderModelConfig,
  getApiProviderModel,
  getDefaultApiProviderModel,
  isValidApiProviderModelConfig,
  isValidApiProviderModelId,
  setApiProviderDefaultModel,
  type ApiProviderModelConfig,
  type ApiProviderConfig
} from "./settings";
import type { SettingsCopy } from "./i18n";
import { renderProviderBrandIcon } from "./provider-brand-icons";
import {
  API_PROVIDER_PRESETS,
  apiProviderApiKeyRequired,
  apiProviderConfiguredDisplayName,
  apiProviderConfiguredNameOverride,
  apiProviderPresetDisplayName,
  getApiProviderModelPreset,
  getApiProviderPreset,
  normalizeApiProviderId,
  type ApiProviderPreset,
  type ApiProviderProtocol
} from "./provider-presets";
import { providerTooltipBaseUrl } from "./provider-tooltip";
import { resolveEchoInkPiReasoningCapabilities } from "./pi-model-catalog";
import {
  ProviderPreflightSession,
  providerPreflightApiKeyReady,
  type ProviderPreflightService
} from "./provider-preflight";
import { applyAmicroButton } from "./amicro-buttons";

type ProviderFormField =
  | "name"
  | "oauth"
  | "apiKey"
  | "endpoint"
  | "model"
  | "protocol";

export type ProviderModelSaveResult =
  | { readonly saved: true }
  | { readonly saved: false; readonly message?: string };

let providerModelModalInstance = 0;

export interface ProviderModelModalOptions {
  readonly app: App;
  readonly draft: ApiProviderConfig;
  readonly editing: boolean;
  readonly language: "zh-CN" | "en";
  readonly copy: SettingsCopy;
  readonly preflight: ProviderPreflightService;
  readonly codexOAuth?: {
    status(): Promise<OpenAICodexAuthStatus>;
    login(interaction: AuthInteraction): Promise<OpenAICodexAuthStatus>;
    logout(): Promise<void>;
    openExternal(url: string): Promise<boolean>;
  };
  readonly save: (
    draft: ApiProviderConfig,
    apiKey: string,
    connectionVerified: boolean
  ) => Promise<ProviderModelSaveResult>;
}

export class ProviderModelModal extends Modal {
  private draft: ApiProviderConfig;
  private apiKeyInput = "";
  private readonly preflight: ProviderPreflightSession;
  private closed = true;
  private suppressModalClose = false;
  private saving = false;
  private invalidatingPreflightInPlace = false;
  private formErrors: Partial<Record<ProviderFormField, string>> = {};
  private focusIntent: string | null = null;
  private liveRegionEl: HTMLElement | null = null;
  private codexAuthStatus: OpenAICodexAuthStatus = {
    state: "disconnected"
  };
  private codexAuthLoading = false;
  private codexLoginController: AbortController | null = null;
  private codexManualCode = "";
  private codexManualResolve: ((value: string) => void) | null = null;
  private codexManualReject: ((error: Error) => void) | null = null;
  private codexAuthUrl = "";
  private codexAuthError = "";
  private manualModelId = "";
  private readonly expandedModels = new Set<string>();
  private readonly numberDrafts = new Map<string, { modelId: string; raw: string; message: string }>();
  private readonly accessibilityId = `echoink-provider-model-${++providerModelModalInstance}`;
  private readonly repositionOpenPickers = (event: Event): void => {
    const target = event.target;
    if (target instanceof (this.modalEl.ownerDocument.defaultView?.HTMLElement ?? HTMLElement) && target.closest(".codex-provider-combobox-menu")) return;
    for (const picker of Array.from(this.modalEl.querySelectorAll<HTMLElement>(".codex-provider-combobox.is-open"))) {
      const trigger = picker.querySelector<HTMLElement>(".codex-provider-combobox-trigger");
      if (trigger) this.positionCombobox(picker, trigger);
    }
  };
  private readonly handleEscapeCapture = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
    const openPicker = this.modalEl.querySelector<HTMLElement>(
      ".codex-provider-combobox.is-open"
    );
    const activeElement = this.modalEl.ownerDocument.activeElement;
    if (
      !openPicker
      || !(activeElement instanceof (this.modalEl.ownerDocument.defaultView?.HTMLElement ?? HTMLElement))
      || !openPicker.contains(activeElement)
    ) return;
    const trigger = openPicker.querySelector<HTMLButtonElement>(
      ".codex-provider-combobox-trigger"
    );
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.closeOpenPickers();
    (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };

  constructor(private readonly options: ProviderModelModalOptions) {
    super(options.app);
    this.draft = structuredClone(options.draft);
    if (!options.editing && this.draft.authMode !== "oauth") {
      this.draft.models = [];
      this.draft.defaultModelId = "";
    }
    this.preflight = new ProviderPreflightSession(
      options.preflight,
      (state) => {
        if (this.closed) return;
        if (state.operation === "model_list" && (state.status === "available" || state.status === "incomplete") && state.source !== "catalog") {
          this.draft.models = this.draft.models.map((model) => {
            const discovered = state.models.find((candidate) => candidate.id === model.id);
            return discovered ? createDiscoveredApiProviderModelConfig(this.providerId, model.id, this.draft.runtimeProviderId, discovered, model) : model;
          });
        }
        this.announce(this.modelStatusText());
        if (this.invalidatingPreflightInPlace && state.status === "idle") {
          this.refreshPreflightStatus();
          return;
        }
        this.render();
      }
    );
  }

  onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("codex-provider-model-modal");
    this.liveRegionEl = this.modalEl.createDiv({
      cls: "codex-provider-modal-live-region",
      attr: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true"
      }
    });
    (this.modalEl.ownerDocument.defaultView ?? window).addEventListener("keydown", this.handleEscapeCapture, true);
    const view = this.modalEl.ownerDocument.defaultView ?? window;
    view.addEventListener("resize", this.repositionOpenPickers);
    view.addEventListener("scroll", this.repositionOpenPickers, true);
    this.render();
    if (this.providerId === "openai-codex") {
      void this.loadCodexAuthStatus();
    }
  }

  private inlineCloseHandler?: () => void;

  setInlineCloseHandler(handler: () => void): void {
    this.inlineCloseHandler = handler;
  }

  close(): void {
    if (this.suppressModalClose) {
      this.suppressModalClose = false;
      return;
    }
    const openPicker = this.modalEl.querySelector<HTMLElement>(
      ".codex-provider-combobox.is-open"
    );
    const activeElement = this.modalEl.ownerDocument.activeElement;
    if (
      openPicker
      && activeElement instanceof (this.modalEl.ownerDocument.defaultView?.HTMLElement ?? HTMLElement)
      && openPicker.contains(activeElement)
    ) {
      const trigger = openPicker.querySelector<HTMLButtonElement>(
        ".codex-provider-combobox-trigger"
      );
      this.closeOpenPickers();
      (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus();
      });
      return;
    }
    if (this.inlineCloseHandler) this.inlineCloseHandler();
    else super.close();
  }

  onClose(): void {
    this.closed = true;
    this.cancelCodexLogin();
    this.dismissProviderUrlTooltips();
    (this.modalEl.ownerDocument.defaultView ?? window).removeEventListener("keydown", this.handleEscapeCapture, true);
    const view = this.modalEl.ownerDocument.defaultView ?? window;
    view.removeEventListener("resize", this.repositionOpenPickers);
    view.removeEventListener("scroll", this.repositionOpenPickers, true);
    this.preflight.reset();
    this.modalEl.onclick = null;
    this.liveRegionEl = null;
    this.modalEl.removeClass("codex-provider-model-modal");
    this.titleEl.empty();
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private get zh(): boolean {
    return this.options.language !== "en";
  }

  private label(chinese: string, english: string): string {
    return this.zh ? chinese : english;
  }

  private get providerId(): ApiProviderPreset["id"] {
    return getApiProviderPreset(normalizeApiProviderId(
      this.draft.providerId,
      this.draft.baseUrl,
      this.draft.name
    )).id;
  }

  private render(): void {
    this.dismissProviderUrlTooltips();
    this.captureFocusIntent();
    for (const panel of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-model-advanced-key]"))) {
      const key = panel.dataset.modelAdvancedKey!;
      if (!panel.hidden) this.expandedModels.add(key); else this.expandedModels.delete(key);
    }
    const focusedTriggerId = this.focusedComboboxTriggerId();
    const providerId = this.providerId;
    this.modalEl.toggleClass("is-custom-provider", providerId === "custom");
    this.titleEl.empty();
    this.titleEl.addClass("codex-provider-modal-title");
    this.titleEl.createSpan({
      cls: "codex-provider-modal-title-text",
      text: this.options.editing
        ? this.label("编辑模型", "Edit model")
        : this.label("添加模型", "Add model")
    });
    if (providerId === "openai-codex") {
      this.titleEl.createSpan({
        cls: "codex-provider-beta-pill",
        text: "Beta"
      });
    }

    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    this.contentEl.addClass("codex-provider-modal-content");
    this.contentEl.createEl("p", {
      cls: "codex-provider-editor-description",
      text: this.label(
        "先连接提供商，再选择模型。保存后会将这条配置设为当前选择。",
        "Connect a provider, then choose models. Saving makes this configuration the current selection."
      )
    });
    const form = this.contentEl.createDiv({ cls: "codex-provider-modal-form" });
    form.setAttr("aria-busy", String(
      this.saving || this.preflight.state.status === "loading"
    ));
    const connection = form.createDiv({ cls: "settings-card provider-connection-card" });
    const connectionHeader = connection.createDiv({ cls: "settings-card-header provider-connection-header" });
    const connectionCopy = connectionHeader.createDiv();
    connectionCopy.createEl("h3", { text: this.label("连接设置", "Connection") });
    connectionCopy.createEl("p", { text: this.label("同一提供商的多套配置，可以用名称区分。", "Use names to distinguish configurations for the same provider.") });
    connectionHeader.createSpan({ cls: "codex-provider-protocol-pill", text: protocolPill(this.draft.apiProtocol) });
    const connectionFields = connection.createDiv({ cls: "provider-connection-grid" });
    this.renderProviderPicker(connectionFields, providerId);
    this.renderProviderNameField(connectionFields);

    if (providerId === "custom") {
      this.renderCustomForm(connection);
    } else {
      if (providerId !== "openai-codex") {
        const endpoint = connection.createDiv({ cls: "codex-provider-endpoint-summary" });
        endpoint.createSpan({ text: this.label("接口地址", "Endpoint") });
        endpoint.createEl("code", { text: this.draft.baseUrl });
      }
      if (providerId === "openai-codex") {
        this.renderCodexOAuth(connection);
      }
      if (apiProviderApiKeyRequired(providerId)) {
        this.renderApiKeyField(connection);
      }
    }
    this.renderModelSelectionField(form);

    const footer = this.contentEl.createDiv({ cls: "codex-provider-modal-footer" });
    const saveState = footer.createDiv({
      cls: "codex-provider-modal-save-state",
      attr: { "aria-live": "off" }
    });
    const actions = footer.createDiv({ cls: "codex-provider-modal-actions" });
    if (providerId !== "openai-codex") {
      const test = createOriginButton(actions, {
        text: this.options.copy.providers.testConnection,
        attr: { type: "button", "data-modal-focus-key": "provider-test-connection" }
      });
      applyAmicroButton(test, { variant: "secondary" });
      test.disabled = !this.canTestConnection() || this.preflight.state.status === "loading" || this.saving;
      test.onclick = () => { this.focusIntent = "provider-test-connection"; void this.testConnection(); };
    }
    const cancel = createOriginButton(actions, {
      text: this.label("取消", "Cancel"),
      attr: { type: "button", "data-modal-focus-key": "cancel" }
    });
    applyAmicroButton(cancel, { variant: "secondary" });
    cancel.onclick = () => this.close();
    const save = createOriginButton(actions, {
      cls: "mod-cta",
      text: this.options.copy.providers.saveAndUse,
      attr: { type: "button", "data-modal-focus-key": "save" }
    });
    applyAmicroButton(save, { variant: "primary", motion: "complete" });
    save.dataset.idleLabel = this.options.copy.providers.saveAndUse;
    save.disabled = this.saving || !this.codexSaveReady();
    save.onclick = () => {
      void (async () => {
        if (!this.validateAndFocusForm()) return;
        this.saving = true;
        save.disabled = true;
        save.textContent = this.options.copy.providers.saving;
        saveState.removeClass("is-error");
        saveState.textContent = this.options.copy.providers.saving;
        this.announce(this.options.copy.providers.saving);
        try {
          const result = await this.options.save(
            this.draft,
            this.apiKeyInput,
            this.preflight.state.operation === "connection"
              && this.preflight.state.status === "available"
          );
          if (result.saved) {
            this.announce(this.options.copy.providers.saved(
              apiProviderConfiguredDisplayName(
                this.providerId,
                this.draft.name,
                this.options.language
              )
            ));
            this.close();
            return;
          }
          saveState.textContent = result.message ?? this.options.copy.providers.saveFailed;
          saveState.addClass("is-error");
          this.announce(saveState.textContent);
        } catch {
          saveState.textContent = this.options.copy.providers.saveFailed;
          saveState.addClass("is-error");
          this.announce(saveState.textContent);
        } finally {
          this.saving = false;
          if (save.isConnected) {
            save.disabled = !this.codexSaveReady();
            save.textContent = save.dataset.idleLabel ?? this.options.copy.providers.saveAndUse;
          }
        }
      })();
    };

    this.modalEl.onclick = (event) => {
      const target = event.target;
      if (!(target instanceof (this.modalEl.ownerDocument.defaultView?.HTMLElement ?? HTMLElement))) return;
      if (target.closest(".codex-provider-combobox")) return;
      this.closeOpenPickers();
    };
    if (this.focusIntent) this.restoreFocusIntent();
    else if (focusedTriggerId) this.restoreComboboxTriggerFocus(focusedTriggerId);
  }

  private renderProviderPicker(
    container: HTMLElement,
    providerId: ApiProviderPreset["id"]
  ): void {
    const row = container.createDiv({ cls: "codex-provider-modal-field" });
    const labelRow = row.createDiv({ cls: "codex-provider-modal-label-row" });
    const providerLabel = labelRow.createDiv({
      cls: "codex-provider-modal-label",
      text: this.label("提供商", "Provider"),
      attr: { id: `${this.providerTriggerId}-label` }
    });
    const selected = getApiProviderPreset(providerId);
    if (selected.docsUrl) {
      labelRow.createEl("a", {
        cls: "codex-provider-doc-link",
        text: this.label("查看文档", "View docs"),
        href: selected.docsUrl,
        attr: {
          target: "_blank",
          rel: "noopener noreferrer"
        }
      });
    }

    const picker = row.createDiv({ cls: "codex-provider-combobox provider-picker" });
    const listboxId = `${this.accessibilityId}-provider-listbox`;
    const trigger = picker.createEl("button", {
      cls: "codex-provider-combobox-trigger",
      attr: {
        type: "button",
        "data-provider-url-tooltip": "true",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-controls": listboxId
      }
    });
    trigger.id = this.providerTriggerId;
    const triggerName = renderProviderIdentity(
      trigger,
      providerId,
      apiProviderPresetDisplayName(providerId, this.options.language)
    );
    triggerName.id = `${this.providerTriggerId}-name`;
    trigger.setAttr("aria-labelledby", `${providerLabel.id} ${triggerName.id}`);
    this.applyProviderUrlTooltip(trigger, providerId);
    const chevron = trigger.createSpan({ cls: "codex-provider-combobox-chevron" });
    setIcon(chevron, "chevron-down");

    const menu = picker.createDiv({
      cls: "codex-provider-combobox-menu provider-picker-menu"
    });
    const searchWrap = menu.createDiv({ cls: "codex-provider-combobox-search" });
    const searchIcon = searchWrap.createSpan();
    setIcon(searchIcon, "search");
    const search = searchWrap.createEl("input", {
      attr: {
        type: "search",
        placeholder: this.label("搜索 Provider", "Search providers"),
        autocomplete: "off",
        "aria-label": this.label("搜索 Provider", "Search providers")
      }
    });
    const levels = menu.createDiv({ cls: "provider-picker-levels" });
    const groups = levels.createDiv({ cls: "provider-picker-groups", attr: { role: "group", "aria-label": this.label("提供商分类", "Provider categories") } });
    const results = levels.createDiv({ cls: "provider-picker-results" });
    const resultsTitle = results.createDiv({ cls: "provider-results-title", attr: { role: "status" } });
    const options = results.createDiv({ cls: "codex-provider-combobox-options provider-picker-options", attr: { role: "listbox", "aria-label": this.label("选择 Provider", "Choose a provider") } });
    options.id = listboxId;
    let activeGroup = providerPickerGroupKey(selected);
    const groupButtons = new Map<ProviderPickerGroupKey, HTMLButtonElement>();
    const optionRows = API_PROVIDER_PRESETS.map((item) => ({
      element: this.renderProviderOption(options, item.id, apiProviderPresetDisplayName(item.id, this.options.language)),
      group: providerPickerGroupKey(item),
      text: `${item.id} ${item.name} ${apiProviderPresetDisplayName(item.id, this.options.language)}`.toLowerCase()
    }));
    const empty = results.createDiv({ cls: "provider-picker-empty", text: this.label("没有匹配的提供商", "No matching providers"), attr: { role: "status" } });
    const footer = menu.createDiv({ cls: "provider-picker-footer" });
    footer.createSpan({ text: this.label("↑ ↓ 选择 · Enter 确认", "↑ ↓ Navigate · Enter Select") });
    footer.createSpan({ text: this.label("Esc 收起", "Esc Close") });
    const applyProviderFilter = (query: string) => {
      menu.toggleClass("is-searching", Boolean(query));
      let count = 0;
      for (const row of optionRows) {
        const visible = query ? row.text.includes(query) : row.group === activeGroup;
        row.element.toggleClass("is-hidden", !visible);
        if (visible) count += 1;
      }
      for (const [key, button] of groupButtons) button.setAttr("aria-pressed", String(key === activeGroup));
      const group = PROVIDER_PICKER_GROUPS.find((item) => item.key === activeGroup)!;
      resultsTitle.setText(query ? this.label(`全部分类 · ${count} 个结果`, `All categories · ${count} results`) : this.label(group.zh, group.en));
      empty.hidden = count > 0;
    };
    for (const group of PROVIDER_PICKER_GROUPS) {
      const button = groups.createEl("button", { cls: "provider-group-button", attr: { type: "button", "aria-pressed": String(group.key === activeGroup) } });
      button.createSpan({ text: this.label(group.zh, group.en) });
      setIcon(button.createSpan({ cls: "provider-group-chevron" }), "chevron-right");
      groupButtons.set(group.key, button);
      button.onclick = (event) => { event.stopPropagation(); activeGroup = group.key; search.value = ""; applyProviderFilter(""); this.positionCombobox(picker, trigger); };
      button.onkeydown = (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        const buttons = Array.from(groupButtons.values());
        const index = buttons.indexOf(button);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        } else if (event.key === "ArrowRight") {
          event.preventDefault(); visibleComboboxOptions(options)[0]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault(); buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault(); search.focus();
        } else if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); closePicker(true);
        }
      };
    }

    const resetProviderFilter = () => {
      search.value = "";
      activeGroup = providerPickerGroupKey(selected);
      applyProviderFilter("");
    };
    const openPicker = (focusTarget: ComboboxFocusTarget) => {
      this.closeOpenPickers();
      picker.addClass("is-open");
      trigger.setAttr("aria-expanded", "true");
      resetProviderFilter();
      this.positionCombobox(picker, trigger);
      focusOpenCombobox(search, options, focusTarget);
    };
    const closePicker = (restoreFocus: boolean) => {
      if (restoreFocus) this.suppressModalCloseForCurrentEvent();
      picker.removeClass("is-open");
      trigger.setAttr("aria-expanded", "false");
      if (restoreFocus) trigger.focus();
    };
    trigger.onclick = (event) => {
      event.stopPropagation();
      if (picker.hasClass("is-open")) {
        closePicker(false);
        return;
      }
      openPicker("search");
    };
    search.onclick = (event) => event.stopPropagation();
    const filterSearch = () => {
      const query = search.value.trim().toLowerCase();
      applyProviderFilter(query);
      this.positionCombobox(picker, trigger);
    };
    search.oninput = (event) => { if (!(event as InputEvent).isComposing) filterSearch(); };
    search.addEventListener("compositionend", filterSearch);
    bindComboboxKeyboard({
      picker,
      trigger,
      search,
      options,
      openPicker,
      closePicker,
      focusGroups: () => groupButtons.get(activeGroup)?.focus()
    });
  }

  private renderProviderOption(
    container: HTMLElement,
    providerId: ApiProviderPreset["id"],
    name: string
  ): HTMLElement {
    const option = container.createEl("button", {
      cls: `codex-provider-combobox-option ${providerId === this.providerId ? "is-selected" : ""}`,
      attr: {
        type: "button",
        role: "option",
        "data-provider-id": providerId,
        "data-provider-url-tooltip": "true",
        "aria-selected": String(providerId === this.providerId),
        tabindex: "-1"
      }
    });
    const optionName = renderProviderIdentity(option, providerId, name);
    optionName.id = `${this.accessibilityId}-provider-option-${providerId}-name`;
    option.setAttr("aria-labelledby", optionName.id);
    this.applyProviderUrlTooltip(option, providerId);
    renderComboboxCheck(option, providerId === this.providerId);
    option.onclick = (event) => {
      event.stopPropagation();
      this.selectProvider(providerId);
    };
    return option;
  }

  private selectProvider(providerId: ApiProviderPreset["id"]): void {
    if (providerId === this.providerId) {
      this.closeOpenPickers();
      this.restoreComboboxTriggerFocus(this.providerTriggerId);
      return;
    }
    if (this.providerId === "openai-codex") {
      this.cancelCodexLogin();
    }
    const replacement = createApiProviderConfig(providerId, this.draft.id);
    this.draft = { ...replacement, apiKey: "" };
    if (!this.options.editing && this.draft.authMode !== "oauth") {
      this.draft.models = [];
      this.draft.defaultModelId = "";
    }
    this.numberDrafts.clear();
    this.formErrors = {};
    this.apiKeyInput = "";
    this.preflight.reset();
    if (providerId === "openai-codex") {
      void this.loadCodexAuthStatus();
    }
    this.restoreComboboxTriggerFocus(this.providerTriggerId);
  }

  private renderProviderNameField(container: HTMLElement): void {
    const inputId = this.controlId("name");
    const field = this.createField(
      container,
      this.label("自定义供应商名称", "Custom provider name"),
      inputId
    );
    const descriptionId = `${inputId}-description`;
    field.createDiv({
      cls: "codex-provider-modal-description",
      text: this.label(
        "可选。用于区分同一供应商下的不同配置。",
        "Optional. Use this to distinguish configurations from the same provider."
      ),
      attr: { id: descriptionId }
    });
    const input = createOriginInput(field, {
      cls: "codex-provider-modal-input",
      attr: {
        id: inputId,
        type: "text",
        maxlength: "80",
        placeholder: this.label(
          `留空则显示“${apiProviderPresetDisplayName(this.providerId, "zh-CN")}”`,
          `Leave blank to show “${apiProviderPresetDisplayName(this.providerId, "en")}”`
        ),
        autocomplete: "off",
        "aria-describedby": descriptionId,
        "data-modal-focus-key": "name"
      }
    });
    input.value = apiProviderConfiguredNameOverride(
      this.providerId,
      this.draft.name
    );
    input.oninput = () => {
      this.draft.name = input.value;
    };
  }

  private renderApiKeyField(container: HTMLElement): void {
    const inputId = this.controlId("apiKey");
    const field = this.createField(container, "API Key", inputId);
    const controls = field.createDiv({ cls: "codex-provider-modal-input-control" });
    const input = createOriginInput(controls, {
      cls: "codex-provider-modal-input",
      attr: {
        id: inputId,
        type: "password",
        autocomplete: "new-password",
        "data-modal-focus-key": "apiKey",
        placeholder: this.draft.apiKey.trim()
          ? this.options.copy.providers.savedKeyPlaceholder
          : this.options.copy.providers.keyPlaceholder
      }
    });
    this.applyFieldAccessibility(input, "apiKey");
    input.value = this.apiKeyInput;
    input.oninput = () => {
      this.apiKeyInput = input.value;
      this.invalidatePreflight(true);
      this.clearFieldError("apiKey", input);
    };
    const reveal = createOriginButton(controls, {
      cls: "codex-provider-modal-icon-button",
      attr: {
        type: "button",
        title: this.options.copy.providers.showKey,
        "aria-label": this.options.copy.providers.showKey,
        "data-modal-focus-key": "toggle-api-key"
      }
    });
    setIcon(reveal, "eye");
    reveal.onclick = () => {
      input.type = input.type === "password" ? "text" : "password";
      reveal.empty();
      setIcon(reveal, input.type === "password" ? "eye" : "eye-off");
      reveal.title = input.type === "password"
        ? this.options.copy.providers.showKey
        : this.options.copy.providers.hideKey;
      reveal.setAttr("aria-label", input.type === "password"
        ? this.options.copy.providers.showKey
        : this.options.copy.providers.hideKey);
    };
    this.renderFieldError(field, "apiKey");
  }

  private renderCodexOAuth(container: HTMLElement): void {
    const card = container.createDiv({
      cls: `codex-provider-oauth-card is-${this.codexAuthStatus.state}`
    });
    const copy = card.createDiv({ cls: "codex-provider-oauth-copy" });
    copy.createDiv({
      cls: "codex-provider-oauth-title",
      text: this.label("OpenAI 浏览器授权", "OpenAI browser authorization")
    });
    copy.createDiv({
      cls: "codex-provider-oauth-description",
      text: this.codexAuthStatus.state === "connected"
        ? this.label("已连接 OpenAI Codex。", "OpenAI Codex is connected.")
        : this.codexAuthStatus.state === "expired"
          ? this.label(
              "已连接；下次请求会安全刷新授权。",
              "Connected; authorization refreshes safely on the next request."
            )
          : this.label(
              "通过浏览器连接 ChatGPT 账户；EchoInk 不会显示访问令牌。",
              "Connect a ChatGPT account in your browser. EchoInk never displays access tokens."
            )
    });

    const actions = card.createDiv({ cls: "codex-provider-oauth-actions" });
    const connected = this.codexAuthStatus.state !== "disconnected";
    if (connected) {
      const logout = createOriginButton(actions, {
        text: this.label("退出登录", "Log out"),
        attr: {
          type: "button",
          "data-modal-focus-key": "codex-oauth-logout"
        }
      });
      logout.disabled = this.codexAuthLoading;
      logout.onclick = () => void this.logoutCodex();
    } else if (!this.codexLoginController) {
      const login = createOriginButton(actions, {
        cls: "mod-cta",
        text: this.codexAuthLoading
          ? this.label("正在读取…", "Loading…")
          : this.label("使用 OpenAI 登录", "Sign in with OpenAI"),
        attr: {
          type: "button",
          "data-modal-focus-key": "codex-oauth-login"
        }
      });
      login.disabled = this.codexAuthLoading || !this.options.codexOAuth;
      login.onclick = () => void this.startCodexLogin();
    }

    if (this.codexAuthUrl) {
      const reopen = createOriginButton(actions, {
        text: this.label("重新打开登录页面", "Reopen login page"),
        attr: {
          type: "button",
          "data-modal-focus-key": "codex-oauth-reopen"
        }
      });
      reopen.onclick = () => {
        void this.options.codexOAuth?.openExternal(this.codexAuthUrl);
      };
    }

    if (this.codexLoginController) {
      const manual = card.createDiv({ cls: "codex-provider-oauth-manual" });
      const inputId = this.controlId("oauth");
      manual.createEl("label", {
        text: this.label(
          "浏览器没有自动完成时，粘贴回调地址或授权码",
          "If the browser does not finish automatically, paste the redirect URL or authorization code"
        ),
        attr: { for: inputId }
      });
      const input = createOriginInput(manual, {
        cls: "codex-provider-modal-input",
        attr: {
          id: inputId,
          type: "text",
          value: this.codexManualCode,
          autocomplete: "off",
          "data-modal-focus-key": "codex-oauth-manual"
        }
      });
      input.oninput = () => {
        this.codexManualCode = input.value;
      };
      const manualActions = manual.createDiv({
        cls: "codex-provider-oauth-manual-actions"
      });
      const finish = createOriginButton(manualActions, {
        cls: "mod-cta",
        text: this.label("完成授权", "Complete authorization"),
        attr: { type: "button" }
      });
      finish.disabled = !this.codexManualCode.trim();
      input.oninput = () => {
        this.codexManualCode = input.value;
        finish.disabled = !this.codexManualCode.trim();
      };
      finish.onclick = () => this.finishCodexManualCode();
      const cancel = createOriginButton(manualActions, {
        text: this.label("停止", "Stop"),
        attr: { type: "button" }
      });
      cancel.onclick = () => {
        this.cancelCodexLogin();
        this.render();
      };
    }

    if (this.codexAuthError) {
      card.createDiv({
        cls: "codex-provider-field-error",
        text: this.codexAuthError,
        attr: { role: "alert" }
      });
    }
  }

  private async loadCodexAuthStatus(): Promise<void> {
    if (!this.options.codexOAuth || this.codexAuthLoading) return;
    this.codexAuthLoading = true;
    this.render();
    try {
      this.codexAuthStatus = await this.options.codexOAuth.status();
      this.codexAuthError = "";
    } catch {
      this.codexAuthStatus = { state: "disconnected" };
      this.codexAuthError = this.label(
        "暂时无法读取登录状态。",
        "The sign-in status is temporarily unavailable."
      );
    } finally {
      this.codexAuthLoading = false;
      if (!this.closed) this.render();
    }
  }

  private async startCodexLogin(): Promise<void> {
    const service = this.options.codexOAuth;
    if (!service || this.codexLoginController) return;
    const controller = new AbortController();
    this.codexLoginController = controller;
    this.codexManualCode = "";
    this.codexAuthUrl = "";
    this.codexAuthError = "";
    this.render();
    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: (event) => this.handleCodexAuthEvent(event),
      prompt: async (prompt) => await this.handleCodexAuthPrompt(prompt)
    };
    try {
      this.codexAuthStatus = await service.login(interaction);
      this.codexAuthUrl = "";
      this.codexAuthError = "";
      this.announce(this.label("OpenAI Codex 已连接。", "OpenAI Codex connected."));
    } catch {
      if (!controller.signal.aborted) {
        this.codexAuthError = this.label(
          "OpenAI 授权未完成，请重试。",
          "OpenAI authorization did not finish. Try again."
        );
      }
    } finally {
      this.codexLoginController = null;
      this.codexManualCode = "";
      this.codexManualResolve = null;
      this.codexManualReject = null;
      if (!this.closed) this.render();
    }
  }

  private handleCodexAuthEvent(event: AuthEvent): void {
    if (event.type !== "auth_url") return;
    this.codexAuthUrl = event.url;
    void this.options.codexOAuth?.openExternal(event.url)
      .then((opened) => {
        if (!opened) {
          this.codexAuthError = this.label(
            "浏览器未能自动打开，请使用“重新打开登录页面”。",
            "The browser could not open automatically. Use “Reopen login page”."
          );
        }
        if (!this.closed) this.render();
      })
      .catch(() => {
        this.codexAuthError = this.label(
          "浏览器未能自动打开，请使用“重新打开登录页面”。",
          "The browser could not open automatically. Use “Reopen login page”."
        );
        if (!this.closed) this.render();
      });
    if (!this.closed) this.render();
  }

  private async handleCodexAuthPrompt(prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") return "browser";
    if (prompt.type !== "manual_code") {
      throw new Error("codex_oauth_prompt_unsupported");
    }
    return await new Promise<string>((resolve, reject) => {
      if (prompt.signal?.aborted) {
        reject(new Error("codex_oauth_prompt_cancelled"));
        return;
      }
      this.codexManualResolve = resolve;
      this.codexManualReject = reject;
      prompt.signal?.addEventListener("abort", () => {
        this.codexManualResolve = null;
        this.codexManualReject = null;
        reject(new Error("codex_oauth_prompt_cancelled"));
      }, { once: true });
      if (!this.closed) this.render();
    });
  }

  private finishCodexManualCode(): void {
    const value = this.codexManualCode.trim();
    if (!value || !this.codexManualResolve) return;
    const resolve = this.codexManualResolve;
    this.codexManualResolve = null;
    this.codexManualReject = null;
    resolve(value);
  }

  private cancelCodexLogin(): void {
    this.codexLoginController?.abort();
    this.codexLoginController = null;
    this.codexManualCode = "";
    this.codexManualReject?.(new Error("codex_oauth_login_cancelled"));
    this.codexManualResolve = null;
    this.codexManualReject = null;
  }

  private async logoutCodex(): Promise<void> {
    if (!this.options.codexOAuth || this.codexAuthLoading) return;
    this.codexAuthLoading = true;
    this.render();
    try {
      await this.options.codexOAuth.logout();
      this.codexAuthStatus = { state: "disconnected" };
      this.codexAuthUrl = "";
      this.codexAuthError = "";
      this.announce(this.label("已退出 OpenAI Codex。", "Logged out of OpenAI Codex."));
    } catch {
      this.codexAuthError = this.label(
        "退出登录失败，请重试。",
        "Log out failed. Try again."
      );
    } finally {
      this.codexAuthLoading = false;
      if (!this.closed) this.render();
    }
  }

  private codexSaveReady(): boolean {
    return this.providerId !== "openai-codex"
      || this.codexAuthStatus.state !== "disconnected";
  }

  private renderModelSelectionField(container: HTMLElement): void {
    const modelCard = container.createDiv({ cls: "settings-card provider-model-card" });
    const field = modelCard.createDiv({ cls: "codex-provider-modal-field" });
    const header = field.createDiv({ cls: "settings-card-header provider-model-header" });
    const copy = header.createDiv();
    copy.createEl("h3", { text: this.label("已启用模型", "Enabled models") });
    copy.createEl("p", { text: this.label("勾选可用模型，再指定一个默认模型。", "Enable available models and choose one as the default.") });
    const actions = header.createDiv({ cls: "codex-provider-model-actions" });
    const discover = createOriginButton(actions, {
      text: this.preflight.state.status === "idle"
        ? this.label("获取模型", "Get models")
        : this.label("刷新模型", "Refresh models"),
      attr: {
        type: "button",
        "data-modal-focus-key": "model-discover"
      }
    });
    applyAmicroButton(discover, { variant: "secondary", icon: "refresh-cw" });
    discover.id = this.modelTriggerId;
    discover.disabled = !this.canDiscoverModels()
      || this.preflight.state.status === "loading";
    discover.onclick = () => {
      this.focusIntent = "model-discover";
      void this.discoverModels();
    };
    const statusRow = field.createDiv({
      cls: `codex-provider-model-status is-${this.preflight.state.status}`,
      attr: { role: "status", "aria-live": "off" }
    });
    this.renderPreflightStatus(statusRow);
    const list = field.createDiv({ cls: "codex-provider-model-checklist" });
    const group = createOriginRadioGroup(list, this.draft.defaultModelId, this.label("默认模型", "Default model"), (modelId) => {
      if (!setApiProviderDefaultModel(this.draft, modelId)) return;
      this.focusIntent = `model-default:${modelId}`;
      this.invalidatePreflight();
      this.render();
    });
    for (const modelId of this.modelChoices()) this.renderModelChoice(group.element, modelId, group);
    this.renderManualModelFallback(field);
    this.renderFieldError(field, "model");
  }

  private renderModelChoice(container: HTMLElement, modelId: string, group: ReturnType<typeof createOriginRadioGroup>): void {
    const enabled = getApiProviderModel(this.draft, modelId);
    const model = enabled ?? this.discoveredModelConfig(modelId);
    const row = container.createDiv({
      cls: `codex-provider-model-choice ${enabled ? "is-enabled" : ""}`
    });
    const selection = row.createDiv({ cls: "codex-provider-model-choice-selection" });
    const enabledLabel = selection.createEl("label", {
      cls: "codex-provider-model-choice-enabled"
    });
    const checkbox = createOriginCheck(enabledLabel, {
      attr: {
        type: "checkbox",
        "data-modal-focus-key": `model-enabled:${modelId}`
      }
    });
    checkbox.checked = Boolean(enabled);
    checkbox.onchange = () => {
      this.focusIntent = `model-enabled:${modelId}`;
      this.setModelEnabled(modelId, checkbox.checked);
    };
    enabledLabel.createSpan({ text: model.displayName || model.id });
    if (model.displayName !== model.id) enabledLabel.createSpan({ cls: "codex-provider-model-tag", text: model.id });
    if (enabled && this.preflight.state.source === "remote" && !this.preflight.state.models.some((candidate) => candidate.id === modelId)) {
      row.createDiv({ cls: "codex-provider-modal-description", text: this.label("已保存；此次列表未返回（保留选择）", "Saved; absent from this list (selection retained)") });
    }
    const actions = selection.createDiv({ cls: "codex-provider-model-choice-actions" });
    const defaultLabel = actions.createEl("label", {
      cls: "codex-provider-model-choice-default"
    });
    const radio = group.addItem(defaultLabel, modelId, !enabled);
    radio.setAttr("data-modal-focus-key", `model-default:${modelId}`);
    radio.setAttr("aria-label", this.label(`默认模型 ${model.id}`, `Default model ${model.id}`));
    defaultLabel.createSpan({
      text: this.label("默认", "Default")
    });
    const capabilityTags = row.createDiv({
      cls: `codex-provider-model-capabilities is-${model.metadataSource}`
    });
    this.renderModelCapabilityTags(capabilityTags, model);
    if (enabled) this.renderModelAdvancedSettings(row, actions, enabled);
    else {
      const placeholder = actions.createSpan({
        cls: "codex-provider-model-parameters is-placeholder",
        text: this.label("参数", "Parameters"),
        attr: { "aria-hidden": "true" }
      });
      setIcon(placeholder.createSpan(), "chevron-down");
    }
  }

  private setModelEnabled(modelId: string, enabled: boolean): void {
    const index = this.draft.models.findIndex((model) => model.id === modelId);
    if (enabled && index < 0) {
      this.draft.models.push(this.discoveredModelConfig(modelId));
      if (!this.draft.defaultModelId) this.draft.defaultModelId = modelId;
    } else if (!enabled && index >= 0) {
      this.draft.models.splice(index, 1);
      if (this.draft.defaultModelId === modelId) {
        this.draft.defaultModelId = this.draft.models[0]?.id ?? "";
      }
    }
    this.invalidatePreflight();
    this.render();
  }

  private renderManualModelFallback(container: HTMLElement): void {
    const fallback = container.createDiv({ cls: "codex-provider-manual-model" });
    fallback.createDiv({
      cls: "codex-provider-manual-model-copy",
      text: this.label(
        "模型列表不可用或缺少目标模型时，可手动添加准确的 Model ID。",
        "If model discovery is unavailable or incomplete, add the exact Model ID manually."
      )
    });
    const controls = fallback.createDiv({ cls: "codex-provider-manual-model-controls" });
    const input = createOriginInput(controls, {
      cls: "codex-provider-modal-input",
      attr: {
        type: "text",
        value: this.manualModelId,
        placeholder: this.label("输入 Model ID", "Enter Model ID"),
        autocomplete: "off",
        "data-modal-focus-key": "manual-model"
      }
    });
    input.oninput = () => {
      this.manualModelId = input.value;
      this.clearFieldError("model", input);
    };
    const add = createOriginButton(controls, {
      attr: {
        type: "button",
        "data-modal-focus-key": "manual-model-add"
      }
    });
    const addIcon = add.createSpan();
    setIcon(addIcon, "plus");
    add.createSpan({ text: this.label("添加", "Add") });
    add.onclick = () => {
      const modelId = this.manualModelId.trim();
      if (!isValidApiProviderModelId(modelId)) {
        this.formErrors.model = this.options.copy.providers.invalidModel;
        this.focusIntent = "manual-model";
        this.render();
        return;
      }
      this.focusIntent = `model-enabled:${modelId}`;
      this.manualModelId = "";
      this.setModelEnabled(modelId, true);
    };
  }

  private renderModelAdvancedSettings(
    container: HTMLElement,
    actions: HTMLElement,
    model: ApiProviderModelConfig
  ): void {
    const modelKey = `${this.providerId}:${model.id}`;
    const panelId = `${this.accessibilityId}-${encodeURIComponent(model.id)}-parameters`;
    const advanced = container.createDiv({
      cls: "codex-provider-model-advanced",
      attr: { id: panelId, "data-model-advanced-key": modelKey }
    });
    advanced.hidden = !(this.expandedModels.has(modelKey)
      || Array.from(this.numberDrafts.values()).some((entry) => entry.modelId === model.id));
    const toggle = createOriginButton(actions, {
      cls: "codex-provider-model-parameters text-button",
      text: this.label("参数", "Parameters"),
      attr: { "data-modal-focus-key": `model:${model.id}:parameters`, "aria-controls": panelId, "aria-expanded": String(!advanced.hidden) }
    });
    setIcon(toggle.createSpan(), "chevron-down");
    toggle.onclick = () => {
      advanced.hidden = !advanced.hidden;
      toggle.setAttr("aria-expanded", String(!advanced.hidden));
      if (advanced.hidden) this.expandedModels.delete(modelKey); else this.expandedModels.add(modelKey);
    };
    const capabilities = advanced.createDiv({
      cls: "codex-provider-model-advanced-group is-capabilities"
    });
    capabilities.createDiv({
      cls: "codex-provider-model-advanced-heading",
      text: this.label("模型能力", "Model capabilities")
    });
    const capabilityDescription = capabilities.createDiv({
      cls: "codex-provider-model-advanced-description",
      text: this.modelCapabilityDescription(model)
    });
    const refreshCapabilityCopy = (): void => {
      capabilityDescription.setText(this.modelCapabilityDescription(model));
      const tags = container.querySelector<HTMLElement>(
        ".codex-provider-model-capabilities"
      );
      if (tags) this.renderModelCapabilityTags(tags, model);
    };
    const toggles = capabilities.createDiv({
      cls: "codex-provider-custom-toggles"
    });
    this.renderToggle(
      toggles,
      this.label("工具调用", "Tool calling"),
      `model:${model.id}:tool-calling`,
      model.toolCalling,
      (value) => {
        model.toolCalling = value;
        model.capabilityOverrides = { ...model.capabilityOverrides, toolCalling: value };
        model.metadataSource = "manual";
        refreshCapabilityCopy();
      }
    );
    this.renderToggle(
      toggles,
      this.label("图片输入", "Image input"),
      `model:${model.id}:image-input`,
      apiProviderModelSupportsImage(model),
      (value) => {
        model.input = value ? ["text", "image"] : ["text"];
        model.capabilityOverrides = { ...model.capabilityOverrides, input: model.input };
        model.metadataSource = "manual";
        refreshCapabilityCopy();
      }
    );
    const reasoningCapabilities = resolveEchoInkPiReasoningCapabilities(
      this.draft.runtimeProviderId,
      model.id,
      model
    );
    const knownCapability = model.discovery?.reasoning !== undefined
      || reasoningCapabilities.source === "catalog"
      || Boolean(getApiProviderModelPreset(this.providerId, model.id));
    const reasoningSupported = knownCapability
      ? reasoningCapabilities.supported
      : model.reasoning || reasoningCapabilities.supported;
    const reasoningAlwaysEnabled = knownCapability
      && reasoningSupported
      && !reasoningCapabilities.supportsOff;
    const reasoningDisabled = knownCapability && (
      !reasoningSupported || reasoningAlwaysEnabled
    );
    this.renderToggle(
      toggles,
      this.label("深度思考", "Deep reasoning"),
      `model:${model.id}:reasoning`,
      reasoningAlwaysEnabled || (
        reasoningSupported && model.reasoningEnabled === true
      ),
      (value) => {
        if (!knownCapability && value) {
          model.reasoning = true;
          model.capabilityOverrides = { ...model.capabilityOverrides, reasoning: true };
          model.reasoningEnabled = true;
          model.metadataSource = "manual";
          refreshCapabilityCopy();
          return;
        }
        model.reasoningEnabled = value;
        refreshCapabilityCopy();
      },
      {
        disabled: reasoningDisabled,
        description: knownCapability && !reasoningSupported
          ? this.label(
            "此模型不支持深度思考。",
            "This model does not support deep reasoning."
          )
          : reasoningAlwaysEnabled
            ? this.label(
              "此模型的深度思考始终开启。",
              "Deep reasoning is always enabled for this model."
            )
            : undefined
      }
    );
    const limits = advanced.createDiv({
      cls: "codex-provider-model-advanced-group is-limits"
    });
    limits.createDiv({
      cls: "codex-provider-model-advanced-heading",
      text: this.label("上下文与输出", "Context and output")
    });
    limits.createDiv({
      cls: "codex-provider-model-advanced-description",
      text: this.label(
        "默认留空并自动使用模型值，无需填写；只有需要手动覆盖时才输入。",
        "Leave these fields blank to use automatic model values. Enter a value only when a manual override is needed."
      )
    });
    const tokens = limits.createDiv({ cls: "codex-provider-context-grid" });
    this.renderModelNumberField(
      tokens,
      model,
      "contextWindow",
      this.label("上下文窗口", "Context window"),
      1_024,
      2_000_000
    );
    this.renderModelNumberField(
      tokens,
      model,
      "modelMaxTokens",
      this.label("模型输出上限", "Model output limit"),
      1,
      1_000_000
    );
    this.renderModelNumberField(
      tokens,
      model,
      "maxOutputTokens",
      this.label("单次输出上限", "Per-request output limit"),
      1,
      1_000_000
    );
  }

  private renderModelNumberField(
    container: HTMLElement,
    model: ApiProviderModelConfig,
    key: "contextWindow" | "modelMaxTokens" | "maxOutputTokens",
    label: string,
    min: number,
    max: number
  ): void {
    const field = container.createDiv({ cls: "codex-provider-context-field" });
    const id = `${this.accessibilityId}-${model.id.replace(/[^A-Za-z0-9_-]/gu, "-")}-${key}`;
    const focusKey = `model:${model.id}:${key}`;
    const invalidDraft = this.numberDrafts.get(focusKey);
    field.createEl("label", { text: label, attr: { for: id } });
    const input = createOriginInput(field, {
      cls: "codex-provider-modal-input",
      attr: {
        id,
        type: "number",
        min: String(min),
        max: String(max),
        step: "1",
        value: invalidDraft ? invalidDraft.raw : model.limitsOverride?.[key] === undefined
          ? ""
          : String(model.limitsOverride[key]),
        placeholder: this.modelLimitPlaceholder(model[key]),
        "data-modal-focus-key": focusKey
      }
    });
    const hintId = `${id}-hint`;
    const hint = field.createDiv({
      cls: "codex-provider-context-field-hint",
      attr: { id: hintId }
    });
    input.setAttr("aria-describedby", hintId);
    const updateHint = (): void => {
      const invalid = this.numberDrafts.get(focusKey);
      input.setAttr("aria-invalid", String(Boolean(invalid)));
      hint.toggleClass("codex-provider-field-error", Boolean(invalid));
      if (invalid) { hint.setText(invalid.message); return; }
      const formattedValue = this.formatModelLimit(model[key]);
      const requested = model.limitsOverride?.[key];
      if (requested !== undefined && requested !== model[key]) {
        hint.setText(this.label(
          `手动值 ${this.formatModelLimit(requested)} 已保留；受当前模型限制，生效值为 ${formattedValue}。`,
          `Manual value ${this.formatModelLimit(requested)} is retained; the current model limit makes the effective value ${formattedValue}.`
        ));
        return;
      }
      hint.setText(model.limitsOverride?.[key] === undefined
        ? this.label(
          `留空即自动使用默认值 ${formattedValue}，无需填写。`,
          `Leave blank to use the automatic default of ${formattedValue}; no entry is required.`
        )
        : this.label(
          `当前手动值 ${formattedValue}；清空即可恢复自动。`,
          `Current manual value: ${formattedValue}. Clear the field to restore automatic mode.`
        ));
    };
    updateHint();
    input.oninput = () => {
      const raw = input.value.trim();
      const value = Number(raw);
      if (input.validity?.badInput || (raw && (!Number.isSafeInteger(value) || value < min || value > max))) {
        this.numberDrafts.set(focusKey, { modelId: model.id, raw: input.value, message: this.label(`请输入 ${min.toLocaleString()}–${max.toLocaleString()} 之间的整数，或留空使用默认值。`, `Enter an integer from ${min.toLocaleString()} to ${max.toLocaleString()}, or leave blank for the default.`) });
        updateHint(); this.invalidatePreflight(); return;
      }
      this.numberDrafts.delete(focusKey);
      if (!this.firstInvalidNumberKey()) {
        delete this.formErrors.model;
        this.modalEl.querySelector(`#${this.errorId("model")}`)?.remove();
      }
      const limitsOverride = { ...model.limitsOverride };
      if (!raw) {
        delete limitsOverride[key];
        applyApiProviderModelLimitsOverride(
          model,
          this.providerId,
          this.draft.runtimeProviderId,
          limitsOverride
        );
        input.placeholder = this.modelLimitPlaceholder(model[key]);
        updateHint();
        this.invalidatePreflight();
        return;
      }
      limitsOverride[key] = value;
      applyApiProviderModelLimitsOverride(
        model,
        this.providerId,
        this.draft.runtimeProviderId,
        limitsOverride
      );
      if (model.limitsOverride?.[key] === undefined) input.value = "";
      input.placeholder = this.modelLimitPlaceholder(model[key]);
      updateHint();
      this.invalidatePreflight();
    };
  }

  private modelCapabilityDescription(model: ApiProviderModelConfig): string {
    if (model.metadataSource === "unknown") {
      return this.label(
        "尚无可靠能力元数据；以下开关使用保守状态，可按 Provider 文档覆盖。",
        "Reliable capability metadata is unavailable. The controls use conservative states and can be overridden from the provider documentation."
      );
    }
    if (model.metadataSource === "manual") {
      return this.label(
        "以下能力包含你保存的手动设置。",
        "These capabilities include your saved manual settings."
      );
    }
    if (model.metadataSource === "discovery") return this.label(
      "优先使用接口明确声明的能力与限制；缺项由已知目录补齐，仍未声明的能力保持待确认。DeepSeek 缺失的工具能力由官方兼容资料补齐。",
      "Provider declarations take priority; the catalog fills missing fields. Undeclared capabilities remain unverified. Official DeepSeek compatibility supplies missing tool capability."
    );
    return model.metadataSource === "catalog"
      ? this.label(
        "能力来自固定 Pi 模型目录，可按 Provider 文档覆盖。",
        "Capabilities come from the pinned Pi model catalog and can be overridden from the provider documentation."
      )
      : this.label(
        "能力来自 EchoInk 内置模型预设，可按 Provider 文档覆盖。",
        "Capabilities come from EchoInk's built-in model preset and can be overridden from the provider documentation."
      );
  }

  private modelCapabilityTags(model: ApiProviderModelConfig): string[] {
    const source = model.metadataSource === "discovery"
      ? this.label("接口发现", "API discovery")
      : model.metadataSource === "unknown"
      ? this.label("能力待确认", "Capabilities unverified")
      : model.metadataSource === "manual"
        ? this.label("手动配置", "Manual configuration")
        : model.metadataSource === "catalog"
          ? this.label("Pi 目录", "Pi catalog")
          : this.label("内置预设", "Built-in preset");
    const unknown = model.metadataSource === "unknown" || (model.discovery && createApiProviderModelConfig(this.providerId, model.id, this.draft.runtimeProviderId).metadataSource === "unknown");
    const input = unknown && !model.discovery?.input && !model.capabilityOverrides?.input
      ? this.label("输入类型未声明", "Input types undeclared")
      : apiProviderModelSupportsImage(model)
      ? this.label("图片输入", "Image input")
      : this.label("仅文字", "text only");
    const reasoningCapabilities = resolveEchoInkPiReasoningCapabilities(
      this.draft.runtimeProviderId,
      model.id,
      model
    );
    const knownCapability = model.discovery?.reasoning !== undefined
      || reasoningCapabilities.source === "catalog"
      || Boolean(getApiProviderModelPreset(this.providerId, model.id));
    const reasoning = knownCapability
      ? reasoningCapabilities.supported
        ? this.label("支持深度思考", "Deep reasoning supported")
        : this.label("不支持深度思考", "Deep reasoning unsupported")
      : unknown && model.capabilityOverrides?.reasoning === undefined
        ? this.label("深度思考未声明", "Deep reasoning undeclared")
        : model.reasoning
        ? this.label("支持深度思考", "Deep reasoning supported")
        : model.capabilityOverrides?.reasoning === false
          ? this.label("不支持深度思考", "Deep reasoning unsupported")
          : this.label("深度思考待确认", "Deep reasoning unverified");
    return [
      source,
      input,
      unknown && model.discovery?.toolCalling === undefined && model.capabilityOverrides?.toolCalling === undefined && !(this.providerId === "deepseek" && model.discovery)
        ? this.label("工具能力未声明", "Tool capability undeclared")
        : model.toolCalling
        ? (this.providerId === "deepseek" && model.discovery && model.discovery.toolCalling === undefined && model.capabilityOverrides?.toolCalling === undefined
          ? this.label("工具调用（官方兼容）", "Tool calling (official compatibility)")
          : this.label("工具调用", "Tool calling"))
        : this.label("无工具调用", "No tool calling"),
      reasoning
    ];
  }

  private renderModelCapabilityTags(
    container: HTMLElement,
    model: ApiProviderModelConfig
  ): void {
    disposeOriginControls(container);
    container.empty();
    container.className = `codex-provider-model-capabilities is-${model.metadataSource}`;
    for (const text of this.modelCapabilityTags(model)) {
      container.createSpan({
        cls: "codex-provider-model-tag",
        text
      });
    }
  }

  private formatModelLimit(value: number): string {
    return value.toLocaleString(this.zh ? "zh-CN" : "en-US");
  }

  private modelLimitPlaceholder(value: number): string {
    const formattedValue = this.formatModelLimit(value);
    return this.label(`自动（${formattedValue}）`, `Auto (${formattedValue})`);
  }

  private renderPreflightStatus(statusRow: HTMLElement): void {
    statusRow.createSpan({ text: this.modelStatusText() });
    if (
      this.preflight.state.operation === "model_list"
      && (
        this.preflight.state.status === "api_key_error"
        || this.preflight.state.status === "rate_or_service_error"
        || this.preflight.state.status === "network_error"
        || this.preflight.state.status === "response_format_error"
        || this.preflight.state.status === "temporary_failure"
      )
    ) {
      const retry = createOriginButton(statusRow, {
        cls: "codex-provider-inline-retry",
        text: this.label("重试", "Retry"),
        attr: {
          type: "button",
          "data-modal-focus-key": "model-retry"
        }
      });
      retry.onclick = () => {
        this.focusIntent = "model-retry";
        void this.discoverModels();
      };
    }
  }

  private refreshPreflightStatus(): void {
    this.contentEl.querySelector<HTMLElement>(".codex-provider-modal-form")
      ?.setAttr("aria-busy", String(
        this.saving || this.preflight.state.status === "loading"
      ));
    const statusRow = this.contentEl.querySelector<HTMLElement>(
      ".codex-provider-model-status"
    );
    if (!statusRow) return;
    statusRow.className = `codex-provider-model-status is-${this.preflight.state.status}`;
    disposeOriginControls(statusRow);
    statusRow.empty();
    this.renderPreflightStatus(statusRow);
    const discover = this.contentEl.querySelector<HTMLButtonElement>(
      '[data-modal-focus-key="model-discover"]'
    );
    if (discover) {
      discover.disabled = !this.canDiscoverModels()
        || this.preflight.state.status === "loading";
    }
    const test = this.contentEl.querySelector<HTMLButtonElement>('[data-modal-focus-key="provider-test-connection"]');
    if (test) test.disabled = !this.canTestConnection() || this.preflight.state.status === "loading" || this.saving;
  }

  private discoveredModelConfig(modelId: string): ApiProviderModelConfig {
    const discovery = this.preflight.state.source !== "catalog"
      ? this.preflight.state.models.find((model) => model.id === modelId)
      : undefined;
    return createApiProviderModelConfig(this.providerId, modelId, this.draft.runtimeProviderId, discovery);
  }

  private modelChoices(): string[] {
    const source = this.preflight.state.models.map((model) => model.id);
    return unique([...source, ...this.draft.models.map((model) => model.id)]);
  }

  private modelStatusText(): string {
    const state = this.preflight.state;
    if (state.operation === "connection") {
      if (state.status === "loading") {
        return this.options.copy.providers.testingConnection;
      }
      if (state.status === "available") {
        return this.options.copy.providers.connectionAvailable;
      }
      if (state.connectionFailure) {
        if (
          state.connectionFailure === "auth"
          && this.providerId === "openai-codex"
        ) {
          return this.label(
            "OpenAI Codex 授权已失效，请重新登录。",
            "OpenAI Codex authorization expired. Sign in again."
          );
        }
        const generic = this.options.copy.providers.connectionFailures[state.connectionFailure];
        const detail = providerFailureDetailText(state.connectionDetail);
        return detail ? `${generic} ${detail}` : generic;
      }
    }
    if (state.status === "loading") {
      return this.providerId === "ollama"
        ? this.label("正在读取本机模型…", "Loading local models…")
        : this.options.copy.providers.modelListLoading;
    }
    if (state.status === "incomplete") return this.label(
      `已读取 ${state.models.length} 个模型，列表未完整返回（分页或数量上限）；可手动添加缺少的 ID。`,
      `Read ${state.models.length} models; the list is incomplete (pagination or limit). Add missing IDs manually.`
    );
    if (state.status === "available") {
      if (state.source === "catalog") return this.label("模型来自内置 Pi 目录；未联网发现。", "Models come from the pinned Pi catalog; no online discovery.");
      if (state.models.length === 0) {
        return this.label(
          "Provider 没有返回可选模型。请确认权限或直接输入已知 Model ID。",
          "The provider returned no models. Check access or enter a known Model ID."
        );
      }
      return this.options.copy.providers.modelListAvailable(
        state.models.length
      );
    }
    if (state.status === "unsupported") {
      return this.label(
        "该 Provider 未开放模型列表，请使用下方手动 Model ID 回退。",
        "This provider does not expose a model list. Use the manual Model ID fallback below."
      );
    }
    if (state.status === "api_key_error") {
      return this.options.copy.providers.modelListApiKeyError;
    }
    if (state.status === "rate_or_service_error") {
      return this.options.copy.providers.modelListRateOrServiceError;
    }
    if (state.status === "network_error") {
      return this.options.copy.providers.modelListNetworkError;
    }
    if (state.status === "response_format_error") {
      return this.options.copy.providers.modelListResponseFormatError;
    }
    if (state.status === "temporary_failure") {
      return this.options.copy.providers.modelListFailed;
    }
    if (
      apiProviderApiKeyRequired(this.providerId)
      && !this.apiKeyInput.trim()
      && !this.draft.apiKey.trim()
    ) {
      return this.label(
        "输入 API Key 后，点击“获取模型”；输入本身不会发起请求。",
        "Enter an API key, then click Get models. Typing the key does not send a request."
      );
    }
    return this.label(
      "点击“获取模型”主动请求一次模型列表；也可手动添加准确的 Model ID。",
      "Click Get models to request the model list once, or add an exact Model ID manually."
    );
  }

  private renderCustomForm(container: HTMLElement): void {
    const fields = container.createDiv({ cls: "provider-connection-grid" });
    const endpointId = this.controlId("endpoint");
    const endpoint = this.createField(
      fields,
      this.label("接口地址", "Endpoint URL"),
      endpointId
    );
    const endpointInput = createOriginInput(endpoint, {
      cls: "codex-provider-modal-input",
      attr: {
        id: endpointId,
        type: "url",
        value: this.draft.baseUrl,
        placeholder: "https://api.example.com/v1/chat/completions",
        autocomplete: "off",
        "data-modal-focus-key": "endpoint"
      }
    });
    this.applyFieldAccessibility(endpointInput, "endpoint");
    endpointInput.oninput = () => {
      this.draft.baseUrl = endpointInput.value;
      this.clearFieldError("endpoint", endpointInput);
      this.invalidatePreflight(true);
      this.syncCurrentProviderUrlTooltips();
    };
    this.renderFieldError(endpoint, "endpoint");

    this.renderCustomProtocolField(fields);
    this.renderApiKeyField(container);
  }

  private renderCustomProtocolField(container: HTMLElement): void {
    const protocolId = this.controlId("protocol");
    const protocolField = this.createField(
      container,
      this.label("API 协议", "API protocol"),
      protocolId
    );
    protocolField.addClass("codex-provider-protocol-field");
    const select = createOriginSelect(protocolField, {
      cls: "codex-provider-modal-input",
      attr: { id: protocolId, "data-modal-focus-key": "protocol" }
    }, (["openai-completions", "openai-responses", "anthropic-messages"] as const)
      .map((item) => ({ value: item, label: this.options.copy.providers.protocolOptions[item] })), this.draft.apiProtocol, this.app).element;
    this.applyFieldAccessibility(select, "protocol");
    select.onchange = () => {
      this.focusIntent = "protocol";
      this.draft.apiProtocol = select.value as ApiProviderProtocol;
      delete this.formErrors.protocol;
      this.invalidatePreflight(true);
      this.updateProtocolPill();
      this.restoreFocusIntent();
    };
    this.renderFieldError(protocolField, "protocol");
  }

  private renderToggle(
    container: HTMLElement,
    label: string,
    focusKey: string,
    checked: boolean,
    onChange: (value: boolean) => void,
    options: Readonly<{
      disabled?: boolean;
      description?: string;
    }> = {}
  ): void {
    const control = container.createEl("label", {
      cls: `codex-provider-custom-toggle${options.disabled ? " is-disabled" : ""}`
    });
    const input = createOriginSwitch(control, {
      cls: "codex-resource-toggle",
      attr: { type: "checkbox", role: "switch", "data-modal-focus-key": `toggle:${focusKey}` }
    });
    input.checked = checked;
    input.disabled = options.disabled === true;
    input.onchange = () => {
      this.focusIntent = `toggle:${focusKey}`;
      onChange(input.checked);
      this.invalidatePreflight();
      this.restoreFocusIntent();
    };
    const copy = control.createSpan({ cls: "codex-provider-custom-toggle-copy" });
    copy.createSpan({
      cls: "codex-provider-custom-toggle-label",
      text: label
    });
    if (options.description) {
      const descriptionId = `${this.accessibilityId}-${focusKey.replace(/[^A-Za-z0-9_-]/gu, "-")}-description`;
      copy.createSpan({
        cls: "codex-provider-custom-toggle-description",
        text: options.description,
        attr: { id: descriptionId }
      });
      input.setAttr("aria-describedby", descriptionId);
    }
  }

  private updateProtocolPill(): void {
    this.contentEl.querySelector<HTMLElement>(".codex-provider-protocol-pill")
      ?.setText(protocolPill(this.draft.apiProtocol));
  }

  private createField(container: HTMLElement, label: string, controlId: string): HTMLElement {
    const field = container.createDiv({ cls: "codex-provider-modal-field" });
    field.createEl("label", {
      cls: "codex-provider-modal-label",
      text: label,
      attr: {
        for: controlId,
        id: `${controlId}-label`,
        "data-provider-field-label": "true"
      }
    });
    return field;
  }

  private controlId(field: ProviderFormField): string {
    return `${this.accessibilityId}-${field}`;
  }

  private errorId(field: ProviderFormField): string {
    return `${this.controlId(field)}-error`;
  }

  private applyFieldAccessibility(control: HTMLElement, field: ProviderFormField): void {
    const error = this.formErrors[field];
    control.setAttr("aria-invalid", String(Boolean(error)));
    const descriptions = [error ? this.errorId(field) : ""].filter(Boolean);
    if (descriptions.length) {
      control.setAttr("aria-describedby", descriptions.join(" "));
    } else control.removeAttribute("aria-describedby");
  }

  private renderFieldError(container: HTMLElement, field: ProviderFormField): void {
    const error = this.formErrors[field];
    if (!error) return;
    container.createDiv({
      cls: "codex-provider-field-error",
      text: error,
      attr: {
        id: this.errorId(field),
        role: "alert"
      }
    });
  }

  private clearFieldError(field: ProviderFormField, control: HTMLElement): void {
    if (!this.formErrors[field]) return;
    delete this.formErrors[field];
    this.applyFieldAccessibility(control, field);
    this.modalEl.querySelector<HTMLElement>(`#${this.errorId(field)}`)?.remove();
  }

  private validateForm(): Partial<Record<ProviderFormField, string>> {
    const errors: Partial<Record<ProviderFormField, string>> = {};
    const requiredKey = apiProviderApiKeyRequired(this.providerId);
    if (requiredKey && !this.apiKeyInput.trim() && !this.draft.apiKey.trim()) {
      errors.apiKey = this.options.copy.providers.missingKey;
    }
    const defaultModel = getDefaultApiProviderModel(this.draft);
    const invalidNumberKey = this.firstInvalidNumberKey();
    if (
      this.draft.models.length === 0
      || !defaultModel
      || this.draft.models.some((model) => !isValidApiProviderModelConfig(model))
      || invalidNumberKey
    ) {
      errors.model = invalidNumberKey
        ? this.numberDrafts.get(invalidNumberKey)!.message
        : this.options.copy.providers.invalidModel;
    }
    if (this.providerId === "custom") {
      const endpoint = this.draft.baseUrl.trim();
      if (!endpoint) {
        errors.endpoint = this.label("请输入 Endpoint URL。", "Enter an endpoint URL.");
      } else {
        try {
          const url = new URL(endpoint);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            errors.endpoint = this.label("Endpoint 必须使用 http 或 https。", "The endpoint must use http or https.");
          }
        } catch {
          errors.endpoint = this.label("请输入有效的 Endpoint URL。", "Enter a valid endpoint URL.");
        }
      }
      if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(this.draft.apiProtocol)) {
        errors.protocol = this.label("请选择支持的 API 协议。", "Choose a supported API protocol.");
      }
    }
    return errors;
  }

  private firstInvalidNumberKey(): string | undefined {
    return Array.from(this.numberDrafts.entries()).find(([, entry]) => this.draft.models.some((model) => model.id === entry.modelId))?.[0];
  }

  private validateAndFocusForm(): boolean {
    const errors = this.validateForm();
    if (!Object.keys(errors).length) return true;
    this.formErrors = errors;
    const [field, message] = Object.entries(errors)[0] as [ProviderFormField, string];
    this.announce(message); this.render(); this.focusField(field);
    return false;
  }

  private captureFocusIntent(): void {
    const activeElement = this.modalEl.ownerDocument.activeElement;
    if (!(activeElement instanceof (this.modalEl.ownerDocument.defaultView?.HTMLElement ?? HTMLElement)) || !this.modalEl.contains(activeElement)) return;
    const focusable = activeElement.closest<HTMLElement>("[data-modal-focus-key]");
    if (focusable?.dataset.modalFocusKey) this.focusIntent = focusable.dataset.modalFocusKey;
  }

  private restoreFocusIntent(): void {
    const key = this.focusIntent;
    if (!key) return;
    this.focusIntent = null;
    this.restoreModalFocusKey(key);
  }

  private restoreModalFocusKey(key: string): void {
    const focusTarget = () => {
      const target = Array.from(
        this.modalEl.querySelectorAll<HTMLElement>("[data-modal-focus-key]")
      ).find((element) => element.dataset.modalFocusKey === key);
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
    focusTarget();
    (this.modalEl.ownerDocument.defaultView ?? window).queueMicrotask(focusTarget);
    (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(focusTarget);
    // Obsidian can restore the modal container's focus in the first paint
    // after a synchronous control change. Correct it in the next paint so a
    // render does not strand keyboard users on the page root.
    (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(focusTarget));
  }

  private focusField(field: ProviderFormField): void {
    const numberKey = field === "model" ? this.firstInvalidNumberKey() : undefined;
    if (numberKey) { this.restoreModalFocusKey(numberKey); return; }
    const target = this.modalEl.querySelector<HTMLElement>(`#${this.controlId(field)}`);
    const focusTarget = () => target?.focus({ preventScroll: true });
    focusTarget();
    (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(focusTarget);
    (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(focusTarget));
  }

  private announce(message: string): void {
    if (this.liveRegionEl) {
      this.liveRegionEl.setText(message);
    }
  }

  private applyProviderUrlTooltip(
    element: HTMLElement,
    providerId: ApiProviderPreset["id"]
  ): void {
    const customBaseUrl = providerId === "custom" && this.providerId === "custom"
      ? this.draft.baseUrl
      : "";
    const url = providerTooltipBaseUrl(providerId, customBaseUrl);
    element.removeAttribute("title");
    if (!url) {
      element.removeAttribute("aria-label");
      element.removeAttribute("data-tooltip-position");
      return;
    }
    setTooltip(element, url, { placement: "top" });
  }

  private dismissProviderUrlTooltips(): void {
    const MouseEventConstructor = this.modalEl.ownerDocument.defaultView?.MouseEvent
      ?? MouseEvent;
    for (const element of Array.from(
      this.modalEl.querySelectorAll<HTMLElement>("[data-provider-url-tooltip]")
    )) {
      element.dispatchEvent(new MouseEventConstructor("mouseleave", {
        relatedTarget: this.modalEl
      }));
      element.dispatchEvent(new MouseEventConstructor("mouseout", {
        bubbles: true,
        relatedTarget: this.modalEl
      }));
    }
  }

  private syncCurrentProviderUrlTooltips(): void {
    const trigger = this.modalEl.querySelector<HTMLElement>(
      `#${this.providerTriggerId}`
    );
    if (trigger) this.applyProviderUrlTooltip(trigger, this.providerId);
    const customOption = this.modalEl.querySelector<HTMLElement>(
      '[data-provider-id="custom"]'
    );
    if (customOption) this.applyProviderUrlTooltip(customOption, "custom");
  }

  private closeOpenPickers(): void {
    for (const picker of Array.from(
      this.modalEl.querySelectorAll<HTMLElement>(".codex-provider-combobox.is-open")
    )) {
      picker.removeClass("is-open");
      picker.removeClass("opens-upward");
      picker.style.removeProperty("--codex-combobox-max-height");
      picker.querySelector<HTMLElement>(".codex-provider-combobox-trigger")
        ?.setAttr("aria-expanded", "false");
    }
  }

  private positionCombobox(picker: HTMLElement, trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    const view = this.modalEl.ownerDocument.defaultView ?? window;
    const viewport = view.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const workspace = picker.closest(".echoink-settings-demo");
    const header = workspace?.querySelector(".codex-settings-tabs-slot")?.getBoundingClientRect();
    const topLimit = Math.max(viewportTop + 8, workspace?.getBoundingClientRect().top ?? 0, header ? header.bottom + 8 : 0);
    const bottomLimit = viewportTop + (viewport?.height ?? view.innerHeight) - 8;
    if (rect.bottom <= topLimit || rect.top >= bottomLimit) { this.closeOpenPickers(); return; }
    const below = Math.max(0, bottomLimit - rect.bottom - 6);
    const above = Math.max(0, rect.top - topLimit - 6);
    const opensUpward = below < 260 && above > below;
    const available = opensUpward ? above : below;
    picker.toggleClass("opens-upward", opensUpward);
    picker.querySelector(".provider-picker-menu")?.toggleClass("is-height-constrained", available < 260);
    picker.style.setProperty(
      "--codex-combobox-max-height",
      `${Math.floor(Math.min(400, available))}px`
    );
  }

  private get providerTriggerId(): string {
    return `${this.accessibilityId}-provider-trigger`;
  }

  private get modelTriggerId(): string {
    return `${this.accessibilityId}-model-trigger`;
  }

  private restoreComboboxTriggerFocus(triggerId: string): void {
    const focusTrigger = () => {
      this.modalEl.querySelector<HTMLButtonElement>(`#${triggerId}`)
        ?.focus({ preventScroll: true });
    };
    focusTrigger();
    (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
      focusTrigger();
      (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(focusTrigger);
    });
  }

  private suppressModalCloseForCurrentEvent(): void {
    this.suppressModalClose = true;
    (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
      this.suppressModalClose = false;
    });
  }

  private focusedComboboxTriggerId(): string | null {
    const activeElement = this.modalEl.ownerDocument.activeElement;
    if (!(activeElement instanceof (this.modalEl.ownerDocument.defaultView?.HTMLElement ?? HTMLElement)) || !this.modalEl.contains(activeElement)) return null;
    const picker = activeElement.closest<HTMLElement>(".codex-provider-combobox");
    if (!picker || !this.modalEl.contains(picker)) return null;
    const trigger = picker.querySelector<HTMLButtonElement>(
      ".codex-provider-combobox-trigger"
    );
    if (
      trigger?.id === this.providerTriggerId
      || trigger?.id === this.modelTriggerId
    ) {
      return trigger.id;
    }
    return null;
  }

  private invalidatePreflight(identityChanged = false): void {
    const refreshModelCard = identityChanged && (this.preflight.state.models.length > 0 || this.draft.models.some((model) => model.discovery));
    if (identityChanged) this.draft.models = this.draft.models.map((model) => {
      if (!model.discovery) return model;
      const baseline = createApiProviderModelConfig(this.providerId, model.id, this.draft.runtimeProviderId);
      if (model.capabilityOverrides) Object.assign(baseline, model.capabilityOverrides, { capabilityOverrides: model.capabilityOverrides, metadataSource: "manual" });
      // Keep field ownership through an identity change, even when no capability
      // was overridden. It also protects explicit limits from baseline pruning.
      baseline.capabilityOverrides = structuredClone(model.capabilityOverrides ?? {});
      baseline.reasoningEnabled = baseline.reasoning && model.reasoningEnabled;
      baseline.reasoningEffort = model.reasoningEffort;
      applyApiProviderModelLimitsOverride(baseline, this.providerId, this.draft.runtimeProviderId, model.limitsOverride);
      return baseline;
    });
    this.invalidatingPreflightInPlace = true;
    try {
      this.preflight.invalidate(identityChanged);
    } finally {
      this.invalidatingPreflightInPlace = false;
    }
    if (refreshModelCard) {
      const form = this.contentEl.querySelector<HTMLElement>(".codex-provider-modal-form");
      const card = form?.querySelector<HTMLElement>(".provider-model-card");
      if (form && card) {
        disposeOriginControls(card);
        card.remove();
        this.renderModelSelectionField(form);
      }
    }
  }

  private apiKeyReady(): boolean {
    return providerPreflightApiKeyReady({
      providerId: this.providerId,
      apiKey: this.apiKeyInput,
      storedApiKey: this.draft.apiKey
    });
  }

  private canDiscoverModels(): boolean {
    return this.apiKeyReady() && Boolean(this.draft.baseUrl.trim());
  }

  private canTestConnection(): boolean {
    return this.apiKeyReady()
      && Boolean(this.draft.baseUrl.trim())
      && Boolean(getDefaultApiProviderModel(this.draft));
  }

  private providerPreflightDraft(): PiProviderConfigurationDraft {
    const model = getDefaultApiProviderModel(this.draft)
      ?? createApiProviderModelConfig(
        this.providerId,
        "",
        this.draft.runtimeProviderId
      );
    return {
      providerSettingsId: this.draft.id,
      providerId: this.providerId,
      runtimeProviderId: this.draft.runtimeProviderId,
      apiProtocol: this.draft.apiProtocol,
      authMode: this.draft.authMode,
      baseUrl: this.draft.baseUrl,
      modelId: model.id,
      apiKey: this.apiKeyInput,
      toolCalling: model.toolCalling,
      imageInput: apiProviderModelSupportsImage(model),
      reasoning: model.reasoning,
      discovery: model.discovery,
      contextWindow: model.contextWindow,
      modelMaxTokens: model.modelMaxTokens,
      maxOutputTokens: model.maxOutputTokens
    };
  }

  private async discoverModels(): Promise<void> {
    if (!this.canDiscoverModels()) return;
    await this.preflight.discoverModels(this.providerPreflightDraft());
  }

  private async testConnection(): Promise<void> {
    if (!this.validateAndFocusForm()) return;
    if (!this.canTestConnection()) return;
    await this.preflight.testConnection(this.providerPreflightDraft());
  }
}

type ComboboxFocusTarget = "search" | "selected" | "last";

type ProviderPickerGroupKey = ApiProviderPreset["group"];

const PROVIDER_PICKER_GROUPS: readonly Readonly<{
  key: ProviderPickerGroupKey;
  zh: string;
  en: string;
}>[] = Object.freeze([
  { key: "account", zh: "登录账户", en: "Account sign-in" },
  { key: "provider", zh: "供应商", en: "Providers" },
  { key: "token-plan", zh: "Token Plan", en: "Token plans" },
  { key: "other", zh: "其他", en: "Other" }
]);

function providerPickerGroupKey(
  preset: Pick<ApiProviderPreset, "group">
): ProviderPickerGroupKey {
  return preset.group;
}

interface ComboboxKeyboardBinding {
  readonly picker: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly search: HTMLInputElement;
  readonly options: HTMLElement;
  readonly openPicker: (focusTarget: ComboboxFocusTarget) => void;
  readonly closePicker: (restoreFocus: boolean) => void;
  readonly focusGroups?: () => void;
}

function visibleComboboxOptions(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      "button.codex-provider-combobox-option:not(.is-hidden):not(:disabled)"
    )
  );
}

function focusOpenCombobox(
  search: HTMLInputElement,
  options: HTMLElement,
  focusTarget: ComboboxFocusTarget
): void {
  (search.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
    if (!search.isConnected || !search.closest(".codex-provider-combobox")?.hasClass("is-open")) return;
    const visible = visibleComboboxOptions(options);
    const selected = visible.find((option) => option.getAttribute("aria-selected") === "true");
    selected?.scrollIntoView({ block: "nearest" });
    if (focusTarget === "search") {
      search.focus({ preventScroll: true });
      return;
    }
    if (!visible.length) {
      search.focus();
      return;
    }
    (selected ?? (focusTarget === "last" ? visible[visible.length - 1] : visible[0])).focus();
  });
}

function bindComboboxKeyboard(binding: ComboboxKeyboardBinding): void {
  const { picker, trigger, search, options, openPicker, closePicker } = binding;
  picker.addEventListener("focusout", (event) => {
    const target = event.relatedTarget;
    if (!target || !(target instanceof (picker.ownerDocument.defaultView?.Node ?? Node)) || !picker.contains(target)) closePicker(false);
  });

  trigger.onkeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      openPicker(event.key === "ArrowUp" ? "last" : "selected");
      return;
    }
    if (event.key === "Escape" && picker.hasClass("is-open")) {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
    }
  };

  search.onkeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const visible = visibleComboboxOptions(options);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!visible.length) return;
      const selected = visible.find((option) => option.getAttribute("aria-selected") === "true");
      (selected ?? (event.key === "ArrowUp" ? visible[visible.length - 1] : visible[0])).focus();
      return;
    }
    if (event.key === "Enter") {
      const selected = visible.find((option) => option.getAttribute("aria-selected") === "true");
      const option = selected ?? visible[0];
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      option.click();
    }
  };

  options.onkeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowLeft" && binding.focusGroups) {
      event.preventDefault(); event.stopPropagation(); binding.focusGroups(); return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
      return;
    }
    if (
      event.key !== "ArrowDown"
      && event.key !== "ArrowUp"
      && event.key !== "Home"
      && event.key !== "End"
    ) return;

    const target = event.target;
    if (!(target instanceof (options.ownerDocument.defaultView?.HTMLElement ?? HTMLElement))) return;
    const current = target.closest<HTMLButtonElement>(
      "button.codex-provider-combobox-option"
    );
    if (!current) return;
    const visible = visibleComboboxOptions(options);
    const currentIndex = visible.indexOf(current);
    if (currentIndex < 0 || !visible.length) return;
    event.preventDefault();
    event.stopPropagation();
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = visible.length - 1;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % visible.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + visible.length) % visible.length;
    visible[nextIndex].focus();
  };
}

function renderComboboxCheck(option: HTMLElement, selected: boolean): void {
  if (!selected) return;
  const check = option.createSpan({
    cls: "codex-provider-option-check",
    attr: { "aria-hidden": "true" }
  });
  setIcon(check, "check");
}

export function renderProviderIdentity(
  container: HTMLElement,
  providerId: ApiProviderPreset["id"],
  name: string
): HTMLElement {
  const icon = container.createSpan({
    cls: `codex-provider-option-icon is-${providerId}`
  });
  renderProviderBrandIcon(icon, providerId);
  return container.createSpan({ cls: "codex-provider-option-name", text: name });
}

function protocolPill(protocol: ApiProviderProtocol): string {
  if (protocol === "openai-codex-responses") return "Codex Responses";
  if (protocol === "anthropic-messages") return "Anthropic Messages API";
  if (protocol === "openai-responses") return "OpenAI Responses API";
  return "OpenAI Chat Completions";
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
