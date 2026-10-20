import type { ApiProviderConfig } from "../../settings/settings";
import { getApiProviderPreset } from "../../settings/provider-presets";
import { MOBILE_MODEL_GROUPS } from "../../mobile/model-configuration";
import { mobileProvider, selectedModel, supportedProvider } from "../../mobile/settings";
import type { MobileShellPage } from "../mobile/shell-types";
import { createModelParametersPage, type IPadProviderDraft } from "./model-parameters";
import { settingsText as t } from "./settings-i18n";
import { el, settingsContent, settingsGroup, settingsRow, settingsBrand, settingsAction, settingsField, settingsError, showSettingsError, liveSettingsPage, leaveSettingsConfirm, type IPadSettingsContext } from "./settings-elements";

const providerLabels: Record<string, readonly [string, string]> = {
  glm: ["智谱 GLM", "智谱开放平台"], kimi: ["Kimi", "月之暗面 · 中国版"], deepseek: ["DeepSeek", "深度求索"],
  qwen: ["通义千问", "阿里云百炼"], "qwen-token-plan": ["通义千问 Token Plan", "阿里云百炼套餐"], custom: ["自定义服务", "兼容 OpenAI 接口"]
};

export function createModelPage(ctx: IPadSettingsContext): MobileShellPage {
  const content = settingsContent(ctx); let signature = "";
  const render = () => {
    const settings = ctx.host.settings(), key = JSON.stringify([settings.settingsLanguage, settings.apiProviders, settings.activeApiProviderId, settings.defaultModel]);
    if (key === signature) return; signature = key; content.replaceChildren();
    const current = selectedModel(settings);
    settingsRow(ctx, settingsGroup(ctx, content, t(ctx, "默认模型")), current?.model.displayName || current?.model.id || t(ctx, "选择默认模型"), "", () => ctx.push(createDefaultModelPage(ctx)), current ? settingsBrand(ctx, current.provider) : undefined, current?.provider.name);
    const group = settingsGroup(ctx, content, t(ctx, "模型服务"));
    for (const provider of settings.apiProviders) {
      const available = supportedProvider(provider) && provider.providerId !== "ollama";
      settingsRow(ctx, group, provider.name, available ? "" : t(ctx, "仅电脑可用"), available ? () => ctx.push(createProviderPage(ctx, provider)) : undefined,
        settingsBrand(ctx, provider), ctx.host.settings().settingsLanguage === "en" ? `${provider.models.length} models` : `${provider.models.length} 个模型`);
    }
    settingsRow(ctx, group, t(ctx, "添加模型服务"), "", () => ctx.push(createAddModelPage(ctx)));
  };
  return liveSettingsPage(ctx, { id: "ipad-settings-model", title: "模型", content }, render);
}

export function createDefaultModelPage(ctx: IPadSettingsContext): MobileShellPage {
  const content = settingsContent(ctx), error = settingsError(ctx); let busy = false, signature = "";
  const render = () => {
    const settings = ctx.host.settings(), key = JSON.stringify([settings.settingsLanguage, settings.apiProviders, settings.activeApiProviderId, settings.defaultModel]);
    if (key === signature) return; signature = key; content.replaceChildren();
    for (const provider of settings.apiProviders.filter(item => supportedProvider(item) && item.providerId !== "ollama")) {
      const group = settingsGroup(ctx, content, provider.name);
      for (const model of provider.models) {
        const selected = settings.activeApiProviderId === provider.id && settings.defaultModel === model.id;
        const row = settingsRow(ctx, group, model.displayName || model.id, selected ? t(ctx, "已选择") : "", async () => {
          if (busy) return; busy = true;
          content.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
          try { await ctx.models.selectDefault(provider.id, model.id); ctx.refresh(); await ctx.back(); }
          catch (failure) { showSettingsError(error, failure); }
          finally { busy = false; content.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; }); }
        }, settingsBrand(ctx, provider)); row.setAttribute("aria-pressed", String(selected)); row.title = model.displayName || model.id;
      }
    }
    if (!content.childElementCount) content.append(el(ctx.document, "p", "pd-settings-empty", t(ctx, "尚未配置模型服务")));
    content.append(error);
  };
  return liveSettingsPage(ctx, { id: "ipad-model-default", title: "默认模型", content }, render);
}

export function createAddModelPage(ctx: IPadSettingsContext): MobileShellPage {
  const content = settingsContent(ctx);
  for (const category of MOBILE_MODEL_GROUPS) {
    const group = settingsGroup(ctx, content, t(ctx, category.title));
    for (const id of category.ids) {
      const [name, description] = providerLabels[id];
      settingsRow(ctx, group, name, "", () => ctx.push(createProviderPage(ctx, mobileProvider(id))), settingsBrand(ctx, { providerId: id }), description);
    }
  }
  return { id: "ipad-model-add", title: t(ctx, "添加模型服务"), content };
}

export function createProviderPage(ctx: IPadSettingsContext, input: ApiProviderConfig): MobileShellPage {
  const provider = ctx.models.createDraft(input), existing = ctx.host.settings().apiProviders.some(item => item.id === provider.id);
  // Preset suggestions are not a fetched model list or an explicit manual choice.
  if (!existing) { provider.models = []; provider.defaultModelId = ""; }
  const content = settingsContent(ctx), fields = el(ctx.document, "fieldset", "pd-model-fields"), error = settingsError(ctx);
  const title = el(ctx.document, "div", "pd-model-provider-title"); title.append(settingsBrand(ctx, provider), el(ctx.document, "span", "", getApiProviderPreset(provider.providerId ?? "custom").name)); fields.append(title);
  const picked = new Set(provider.models.map(model => model.id));
  let disposed = false, fetching = false, saving = false, nested = false, allowLeave = false, fetched = existing, incomplete = false, manualAdded = false;
  let leave: Promise<boolean> | undefined;
  const baseline = JSON.stringify(provider), selectionBaseline = JSON.stringify([...picked]);
  const state: IPadProviderDraft = { provider, selected: picked, manualAdded: () => { manualAdded = true; }, changed: () => { error.hidden = true;
    if (content.closest<HTMLElement>(".echoink-ipad-page")?.hidden) renderModels(); else update();
  } };
  const name = settingsField(ctx, fields, t(ctx, "连接名称"), provider.name, value => { provider.name = value; state.changed(); }); name.autocomplete = "off";
  const key = settingsField(ctx, fields, "API Key", provider.apiKey, value => { provider.apiKey = value; state.changed(); }, "password"); key.autocomplete = "off"; key.spellcheck = false;
  const url = settingsField(ctx, fields, t(ctx, "接口地址"), provider.baseUrl, value => { provider.baseUrl = value; state.changed(); }, "url"); url.autocomplete = "off"; url.spellcheck = false;
  const parameterGroup = el(ctx.document, "div", "pd-settings-group"); fields.append(parameterGroup);
  settingsRow(ctx, parameterGroup, t(ctx, "参数"), "", async () => {
    nested = true; try { await ctx.push(createModelParametersPage(ctx, state)); } finally { nested = false; renderModels(); }
  });
  const heading = el(ctx.document, "div", "pd-model-list-heading"); heading.append(el(ctx.document, "h2", "pd-settings-label", t(ctx, "模型")));
  const fetch = settingsAction(ctx, "获取模型", async () => {
    if (fetching || saving || !provider.apiKey.trim()) return; fetching = true; error.hidden = true; update();
    try {
      const response = await ctx.models.fetchModels(provider); if (disposed) return;
      const known = new Map(provider.models.map(model => [model.id, model]));
      for (const model of response.models) if (!known.has(model.id)) known.set(model.id, model);
      provider.models = [...known.values()]; fetched = true; incomplete = response.incomplete;
      // Selection remains explicit: fetching alone never saves or selects newly discovered models.
      renderModels();
      if (!response.models.length) showSettingsError(error, t(ctx, "模型列表为空，可在参数页手动添加 Model ID。"));
    } catch (failure) { if (!disposed) showSettingsError(error, failure); }
    finally { fetching = false; update(); }
  }); heading.append(fetch); fields.append(heading);
  const models = el(ctx.document, "div", "pd-model-choices"); fields.append(models); content.append(fields, error);
  const footer = el(ctx.document, "div", "pd-model-footer"), leaveArea = el(ctx.document, "div", "pd-model-leave"), actions = el(ctx.document, "div", "pd-settings-actions"); footer.append(leaveArea, actions);
  const cancel = settingsAction(ctx, "取消", () => ctx.back());
  const save = settingsAction(ctx, "测试并保存", async () => {
    if (saving || fetching || !picked.size || !provider.apiKey.trim() || !existing && !fetched && !manualAdded) return;
    const allModels = provider.models; saving = true; error.hidden = true; update();
    provider.models = allModels.filter(model => picked.has(model.id));
    try { await ctx.models.save(provider); allowLeave = true; ctx.refresh(); if (!disposed) await ctx.shell.activePageShell?.backTo("ipad-settings-model"); }
    catch (failure) { if (!disposed) showSettingsError(error, failure); }
    finally { provider.models = allModels; saving = false; update(); }
  }, true); actions.append(cancel, save);
  function renderModels(): void {
    if (disposed) return; models.replaceChildren();
    for (const model of provider.models) {
      const label = el(ctx.document, "label", "pd-settings-row pd-model-choice"), checkbox = el(ctx.document, "input", "pd-model-checkbox"); checkbox.type = "checkbox"; checkbox.checked = picked.has(model.id); checkbox.setAttribute("aria-label", model.displayName || model.id);
      label.append(settingsBrand(ctx, provider), el(ctx.document, "span", "pd-settings-copy", model.displayName || model.id), checkbox);
      checkbox.addEventListener("change", () => { if (checkbox.checked) picked.add(model.id); else picked.delete(model.id); state.changed(); }); models.append(label);
    }
    if (incomplete) models.append(el(ctx.document, "div", "pd-settings-error", t(ctx, "模型列表不完整")));
    update();
  }
  function update(): void {
    if (disposed) return;
    fields.disabled = saving; cancel.disabled = saving; fetch.disabled = fetching || saving || !provider.apiKey.trim(); save.disabled = saving || fetching || !provider.name.trim() || !provider.apiKey.trim() || !picked.size || !existing && !fetched && !manualAdded;
    fetch.firstElementChild!.textContent = t(ctx, fetching ? "读取中…" : fetched ? "重新获取" : "获取模型");
    save.firstElementChild!.textContent = t(ctx, saving ? "测试中…" : "测试并保存"); save.setAttribute("aria-busy", String(saving));
  }
  if (existing) {
    const removeArea = el(ctx.document, "div", "pd-model-danger");
    const remove = settingsAction(ctx, "删除模型服务", () => {
      removeArea.replaceChildren(el(ctx.document, "p", "", t(ctx, "删除此连接？")));
      removeArea.append(settingsAction(ctx, "取消", () => { removeArea.replaceChildren(remove); }), settingsAction(ctx, "删除", async () => {
        if (saving || fetching) return; saving = true; update();
        try { await ctx.models.remove(provider.id); allowLeave = true; ctx.refresh(); await ctx.shell.activePageShell?.backTo("ipad-settings-model"); }
        catch (failure) { showSettingsError(error, failure); } finally { saving = false; update(); }
      }));
    }); removeArea.append(remove); fields.append(removeArea);
  }
  renderModels();
  return { id: `ipad-model-provider-${provider.id}`, title: t(ctx, existing ? "编辑模型服务" : "填写模型服务"), content, footer,
    canLeave: () => {
      if (allowLeave) return true;
      if (saving || fetching) return false;
      if (nested || JSON.stringify(provider) === baseline && JSON.stringify([...picked]) === selectionBaseline) return true;
      if (!leave) leave = leaveSettingsConfirm(ctx, leaveArea).then(allowed => { if (allowed) allowLeave = true; leave = undefined; return allowed; }); return leave;
    }, dispose: () => { disposed = true; } };
}
