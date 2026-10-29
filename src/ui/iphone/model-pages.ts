import type { ApiProviderConfig, ApiProviderModelConfig } from "../../settings/settings";
import { getApiProviderPreset, type ApiProviderId, type ApiProviderProtocol } from "../../settings/provider-presets";
import { MobileModelConfiguration, MOBILE_MODEL_GROUPS, validateMobileModelParameters } from "../../mobile/model-configuration";
import { mobileModel, mobileProvider, selectedModel, supportedProvider } from "../../mobile/settings";
import type { MobileShellPage } from "../mobile/shell-types";
import { settingsMessage, settingsText } from "./settings-language";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneElement as el, iphoneIcon } from "./workbench-elements";
import { pushSettingsPage, settingsBody, settingsBrand, settingsButton, settingsCheck, settingsError, settingsField, settingsGroup, settingsRow } from "./settings-elements";

const unavailable = (provider: ApiProviderConfig) => provider.providerId === "ollama" ? "本地模型，只能在电脑上用" : provider.authMode === "oauth" ? "账号登录方式，只能在电脑上用" : "此接口暂不支持移动端";
const mobileAvailable = (provider: ApiProviderConfig) => supportedProvider(provider) && provider.providerId !== "ollama";
const providerLabels: Partial<Record<ApiProviderId, [string, string]>> = {
  glm: ["智谱 GLM", "智谱开放平台"], kimi: ["Kimi", "月之暗面 · 中国版"], deepseek: ["DeepSeek", "深度求索"],
  qwen: ["通义千问", "阿里云百炼"], "qwen-token-plan": ["通义千问 Token Plan", "阿里云百炼套餐"], custom: ["自定义服务", "兼容 OpenAI 接口"]
};
const providerName = (id: ApiProviderId) => providerLabels[id]?.[0] ?? getApiProviderPreset(id).name.split(" / ")[0];

/** Pure model requests/persistence are shared; all page state and rendering stay on iPhone. */
export class IPhoneModelPages {
  private readonly configuration: MobileModelConfiguration;
  private renderList?: () => void;
  private readonly verified = new Map<string, string>();
  constructor(private readonly ctx: IPhonePageContext, private readonly changed: () => void) {
    this.configuration = new MobileModelConfiguration(ctx.host.settings, ctx.host.saveSettings, ctx.host.modelRequest, ctx.host.services.usageObserver);
  }
  async open(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-model";
    if (ctx.shell.hasPage(id)) { this.renderList?.(); await ctx.shell.backTo(id); return; }
    const body = settingsBody(ctx);
    const render = () => {
      body.replaceChildren(); const current = selectedModel(ctx.host.settings());
      const defaults = settingsGroup(ctx, body, "默认模型");
      settingsRow(ctx, defaults, current?.model.displayName || current?.model.id || "选择默认模型", { literal: !!current, leading: current ? settingsBrand(ctx, current.provider.providerId) : iphoneIcon(ctx.document, "sparkles"), detail: current?.provider.name, literalDetail: true, action: () => this.defaults() });
      const providers = settingsGroup(ctx, body, "模型服务");
      for (const provider of ctx.host.settings().apiProviders) settingsRow(ctx, providers, provider.name, {
        literal: true, leading: settingsBrand(ctx, provider.providerId), detail: mobileAvailable(provider) ? `${provider.models.length} 个模型` : unavailable(provider),
        value: this.verified.get(provider.id) === JSON.stringify(provider) ? "已连接" : undefined, valueLeading: this.verified.get(provider.id) === JSON.stringify(provider) ? iphoneIcon(ctx.document, "circle-check") : undefined,
        action: mobileAvailable(provider) ? () => this.form(provider) : undefined
      });
      settingsRow(ctx, providers, "添加模型服务", { icon: "plus", action: () => this.add() });
    };
    this.renderList = render; render();
    await pushSettingsPage(ctx, { id, title: "模型", content: body, dispose: () => { if (this.renderList === render) this.renderList = undefined; } });
  }
  private refresh(): void { this.renderList?.(); this.changed(); }
  private async defaults(): Promise<void> {
    const { ctx } = this, body = settingsBody(ctx), error = settingsError(ctx, body); let busy = false;
    const providers = ctx.host.settings().apiProviders.filter(mobileAvailable);
    if (!providers.some(provider => provider.models.length)) settingsRow(ctx, settingsGroup(ctx, body), "添加模型服务", { icon: "plus", action: () => this.add() });
    for (const provider of providers) {
      const group = settingsGroup(ctx, body, provider.name, true);
      for (const model of provider.models) settingsRow(ctx, group, model.displayName || model.id, { literal: true, leading: settingsBrand(ctx, provider.providerId), selected: ctx.host.settings().activeApiProviderId === provider.id && ctx.host.settings().defaultModel === model.id, action: async () => {
        if (busy) return; busy = true; error.show(); for (const button of Array.from(body.querySelectorAll("button"))) button.disabled = true;
        try { await this.configuration.selectDefault(provider.id, model.id); this.refresh(); busy = false; await ctx.shell.back(); }
        catch (failure) { error.show(failure); busy = false; for (const button of Array.from(body.querySelectorAll("button"))) button.disabled = false; }
      } });
    }
    await pushSettingsPage(ctx, { id: "iphone-settings-default-model", title: "默认模型", content: body, canLeave: () => !busy });
  }
  private async add(): Promise<void> {
    const { ctx } = this, body = settingsBody(ctx);
    for (const section of MOBILE_MODEL_GROUPS) {
      const group = settingsGroup(ctx, body, section.title);
      for (const id of section.ids) settingsRow(ctx, group, providerName(id), { leading: settingsBrand(ctx, id), detail: providerLabels[id]?.[1], value: ctx.host.settings().apiProviders.some(provider => provider.providerId === id) ? "已添加" : undefined, action: () => this.form(id) });
    }
    await pushSettingsPage(ctx, { id: "iphone-settings-add-provider", title: "添加模型服务", content: body });
  }
  private async form(source: ApiProviderConfig | ApiProviderId): Promise<void> {
    const { ctx } = this, editing = typeof source !== "string";
    const draft = this.configuration.createDraft(typeof source === "string" ? mobileProvider(source) : source);
    if (!editing) draft.name = providerName(draft.providerId ?? "custom");
    const body = settingsBody(ctx), fields = el(ctx.document, "fieldset", "ip-settings-fields"); body.append(fields);
    const title = el(ctx.document, "div", "ip-settings-provider-title"); title.append(settingsBrand(ctx, draft.providerId), settingsMessage(ctx, el(ctx.document, "span", ""), providerName(draft.providerId ?? "custom"))); fields.append(title);
    let disposed = false, busy = false, saving = false, fetched = false, manualAdded = false, revision = 0, fetchRevision = 0;
    const choices = new Map(draft.models.map(model => [model.id, model])), picked = new Set(editing ? draft.models.map(model => model.id) : []);
    const editedModels = new Set<string>();
    const invalidate = () => { revision++; error.show(); update(); };
    const name = settingsField(ctx, fields, "连接名称", draft.name, value => { draft.name = value; invalidate(); }); name.autocomplete = "off";
    const key = settingsField(ctx, fields, "API Key", draft.apiKey, value => { draft.apiKey = value; invalidate(); }, "password"); key.placeholder = settingsText(ctx, "粘贴 API Key"); key.autocomplete = "off"; key.spellcheck = false;
    const url = settingsField(ctx, fields, "接口地址", draft.baseUrl, value => { draft.baseUrl = value; invalidate(); }, "url"); url.placeholder = "HTTPS://"; url.autocomplete = "off"; url.spellcheck = false;
    settingsRow(ctx, settingsGroup(ctx, fields), "参数", { value: "沿用", action: () => this.parameters(draft, choices, picked, editedModels, added => { revision++; manualAdded ||= added === true; renderModels(); update(); }) });
    const head = el(ctx.document, "div", "ip-settings-model-head"); head.append(el(ctx.document, "h2", "", "模型")); settingsMessage(ctx, head.querySelector("h2")!, "模型"); fields.append(head);
    const fetch = settingsButton(ctx, "获取模型", () => { void discover(); }); head.append(fetch);
    const models = el(ctx.document, "div", "ip-settings-model-choices"); fields.append(models);
    const status = el(ctx.document, "div", "ip-settings-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); body.append(status);
    const error = settingsError(ctx, body), footer = el(ctx.document, "div", "ip-settings-actions"), confirmation = el(ctx.document, "div", "ip-settings-confirm"); confirmation.hidden = true;
    body.append(confirmation);
    const cancel = settingsButton(ctx, "取消", () => { if (!busy) void ctx.shell.back(); });
    const save = settingsButton(ctx, "测试并保存", () => { void persist(); }, "is-primary");
    const remove = editing ? settingsButton(ctx, "删除模型服务", () => { confirmation.hidden = !confirmation.hidden; }, "is-danger") : undefined;
    if (remove) footer.append(remove); footer.append(cancel, save);
    const update = () => {
      fields.disabled = busy; cancel.disabled = busy; save.disabled = busy || !draft.apiKey.trim() || !picked.size || !(editing || fetched || manualAdded); if (remove) remove.disabled = busy;
      fetch.disabled = busy || !draft.apiKey.trim() || !draft.baseUrl.trim();
      settingsMessage(ctx, fetch.querySelector<HTMLElement>(".ip-button-visible > span:last-child")!, busy && fetchRevision ? "读取中…" : editing || fetched ? "重新获取" : "获取模型");
      settingsMessage(ctx, save.querySelector<HTMLElement>(".ip-button-visible > span:last-child")!, saving ? "测试中…" : "测试并保存");
    };
    const renderModels = () => {
      models.replaceChildren();
      if (!editing && !fetched && !manualAdded) return;
      for (const model of choices.values()) settingsCheck(ctx, models, model.displayName || model.id, picked.has(model.id), checked => {
        if (checked) picked.add(model.id); else picked.delete(model.id); error.show(); update();
      }, settingsBrand(ctx, draft.providerId), true);
    };
    const discover = async () => {
      if (busy || fetch.disabled) return;
      busy = true; const token = ++fetchRevision, atRevision = revision; error.show(); status.textContent = ""; update();
      try {
        const result = await this.configuration.fetchModels(draft);
        if (disposed || fetchRevision !== token || revision !== atRevision) return;
        for (const model of result.models) {
          const previous = choices.get(model.id);
          choices.set(model.id, previous ? editedModels.has(model.id) ? previous : { ...previous, ...model } : model);
        }
        fetched = true; status.textContent = result.incomplete ? "模型列表尚未完整返回，可重试或手动添加 Model ID。" : result.models.length ? "" : "没有读取到模型，可重试或在参数中手动添加 Model ID。";
        renderModels();
      } catch (failure) { if (!disposed && fetchRevision === token) error.show(failure); }
      finally { if (!disposed && fetchRevision === token) { busy = false; fetchRevision = 0; update(); } }
    };
    const persist = async () => {
      if (busy || save.disabled) return; busy = true; saving = true; error.show(); status.textContent = ""; update();
      draft.models = [...choices.values()].filter(model => picked.has(model.id));
      if (!draft.models.some(model => model.id === draft.defaultModelId)) draft.defaultModelId = draft.models[0]?.id ?? "";
      try {
        await this.configuration.save(draft); const saved = ctx.host.settings().apiProviders.find(provider => provider.id === draft.id); if (saved) this.verified.set(draft.id, JSON.stringify(saved)); this.refresh(); busy = false;
        if (!disposed) await ctx.shell.backTo("iphone-settings-model");
      } catch (failure) { if (!disposed) error.show(failure); }
      finally { saving = false; if (!disposed) { busy = false; update(); } }
    };
    if (remove) {
      confirmation.append(settingsMessage(ctx, el(ctx.document, "p", ""), "删除此模型服务及已选模型？"));
      confirmation.append(settingsButton(ctx, "取消", () => { confirmation.hidden = true; }));
      const confirm = settingsButton(ctx, "删除", () => { void (async () => {
        if (busy) return; busy = true; update(); confirm.disabled = true; error.show();
        try { await this.configuration.remove(draft.id); this.verified.delete(draft.id); this.refresh(); busy = false; await ctx.shell.backTo("iphone-settings-model"); }
        catch (failure) { error.show(failure); }
        finally { busy = false; confirm.disabled = false; update(); }
      })(); }, "is-danger"); confirmation.append(confirm);
    }
    renderModels(); update();
    await pushSettingsPage(ctx, { id: `iphone-settings-provider-${draft.id}`, title: editing ? "编辑模型服务" : "填写模型服务", content: body, footer, canLeave: () => !busy, dispose: () => { disposed = true; fetchRevision++; } });
  }
  private async parameters(draft: ApiProviderConfig, models: Map<string, ApiProviderModelConfig>, picked: Set<string>, edited: Set<string>, changed: (manualAdded?: boolean) => void): Promise<void> {
    const { ctx } = this, body = settingsBody(ctx), connection = settingsGroup(ctx, body, "连接"), error = settingsError(ctx, body);
    const protocolLabel = el(ctx.document, "label", "ip-settings-field"), protocol = el(ctx.document, "select", "ip-settings-input");
    protocolLabel.append(settingsMessage(ctx, el(ctx.document, "span", "ip-settings-field-label"), "协议"), protocol); connection.append(protocolLabel); protocol.setAttribute("aria-label", "协议");
    const protocols: [ApiProviderProtocol, string][] = [["openai-completions", "Chat Completions"], ["openai-responses", "Responses"]];
    if (!protocols.some(([id]) => id === draft.apiProtocol)) protocols.push([draft.apiProtocol, draft.apiProtocol]);
    for (const [id, name] of protocols) { const option = el(ctx.document, "option", "", name); option.value = id; protocol.append(option); }
    protocol.value = draft.apiProtocol; protocol.addEventListener("change", () => { draft.apiProtocol = protocol.value as ApiProviderProtocol; changed(); });
    const modelArea = el(ctx.document, "div", "ip-settings-parameters"); body.append(modelArea);
    const invalid = new Set<HTMLInputElement>();
    const renderModel = (model: ApiProviderModelConfig) => {
      const group = settingsGroup(ctx, modelArea, model.displayName || model.id, true), name = settingsRow(ctx, group, model.displayName || model.id, { literal: true, leading: settingsBrand(ctx, draft.providerId) }); name.setAttribute("aria-label", model.id);
      const idError = settingsError(ctx, group);
      const idInput = settingsField(ctx, group, "Model ID", model.id, value => {
        const id = value.trim();
        if (!/^[^\s\p{Cc}]{1,256}$/u.test(id) || models.has(id) && models.get(id) !== model) {
          invalid.add(idInput); idInput.setAttribute("aria-invalid", "true"); idError.show("Model ID 无效或重复。"); return;
        }
        invalid.delete(idInput); idInput.removeAttribute("aria-invalid"); idError.show();
        const previous = model.id, selected = picked.delete(previous); models.delete(previous);
        model.id = id; if (model.displayName === previous) model.displayName = id;
        models.set(id, model); if (selected) picked.add(id); if (draft.defaultModelId === previous) draft.defaultModelId = id;
        edited.add(id); name.querySelector(".ip-settings-name")!.textContent = model.displayName || id; name.setAttribute("aria-label", id); changed();
      }); idInput.autocomplete = "off"; idInput.spellcheck = false;
      for (const [key, label] of [["contextWindow", "上下文窗口"], ["modelMaxTokens", "模型输出上限"], ["maxOutputTokens", "单次输出上限"]] as const) {
        const fieldError = settingsError(ctx, group);
        const input = settingsField(ctx, group, label, String(model[key]), value => {
          const number = Number(value);
          if (!Number.isSafeInteger(number) || number <= 0) { invalid.add(input); input.setAttribute("aria-invalid", "true"); fieldError.show(`${label}请填写正整数。`); return; }
          invalid.delete(input); input.removeAttribute("aria-invalid"); model[key] = number; model.limitsOverride = { ...model.limitsOverride, [key]: number }; edited.add(model.id); changed();
          try { validateMobileModelParameters(model); fieldError.show(); }
          catch (failure) { fieldError.show(failure); }
        }, "number"); input.min = "1"; input.step = "1"; input.inputMode = "numeric";
      }
      settingsCheck(ctx, group, "支持工具调用", model.toolCalling, checked => { model.toolCalling = checked; model.capabilityOverrides = { ...model.capabilityOverrides, toolCalling: checked }; edited.add(model.id); changed(); });
      settingsCheck(ctx, group, "图片输入", model.input.includes("image"), checked => { model.input = checked ? [...new Set([...model.input, "text" as const, "image" as const])] : model.input.filter(value => value !== "image"); model.capabilityOverrides = { ...model.capabilityOverrides, input: [...model.input] }; edited.add(model.id); changed(); });
      settingsCheck(ctx, group, "支持思考", model.reasoning, checked => { model.reasoning = checked; if (!checked) model.reasoningEnabled = false; model.capabilityOverrides = { ...model.capabilityOverrides, reasoning: checked }; edited.add(model.id); changed(); });
      const reasoning = settingsCheck(ctx, group, "使用思考", model.reasoningEnabled, checked => { model.reasoningEnabled = checked; edited.add(model.id); changed(); });
      reasoning.disabled = !model.reasoning;
      // Capability and user preference stay distinct, with no nested switches.
      const capability = Array.from(group.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))[2];
      capability.addEventListener("change", () => { reasoning.disabled = !model.reasoning; reasoning.checked = model.reasoningEnabled; });
    };
    for (const model of models.values()) renderModel(model);
    const manual = settingsGroup(ctx, body, "手动添加 Model ID"); let manualId = "";
    const input = settingsField(ctx, manual, "Model ID", "", value => { manualId = value; add.disabled = !value.trim(); }); input.placeholder = settingsText(ctx, "例如 deepseek-chat"); input.autocomplete = "off"; input.spellcheck = false;
    const add = settingsButton(ctx, "添加模型", () => {
      const id = manualId.trim(); if (!id) return;
      let model = models.get(id); if (!model) { model = mobileModel(id); models.set(id, model); renderModel(model); }
      picked.add(id); edited.add(id); input.value = ""; manualId = ""; add.disabled = true; error.show(); changed(true);
    }); add.disabled = true; manual.append(add);
    const page: MobileShellPage = { id: `iphone-settings-provider-parameters-${draft.id}`, title: "参数", content: body, canLeave: () => {
      if (invalid.size) { error.show("请先修正参数。"); [...invalid][0]?.focus(); return false; }
      try { for (const model of models.values()) validateMobileModelParameters(model); error.show(); changed(); return true; }
      catch (failure) { error.show(failure); return false; }
    } };
    await pushSettingsPage(ctx, page);
  }
}
