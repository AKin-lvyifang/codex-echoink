import type { ApiProviderConfig, ApiProviderModelConfig } from "../../settings/settings";
import { mobileModel } from "../../mobile/settings";
import { validateMobileModelParameters } from "../../mobile/model-configuration";
import type { MobileShellPage } from "../mobile/shell-types";
import { settingsText as t } from "./settings-i18n";
import { el, settingsContent, settingsGroup, settingsField, settingsSwitch, settingsAction, settingsBrand, settingsError, showSettingsError, type IPadSettingsContext } from "./settings-elements";

export interface IPadProviderDraft { provider: ApiProviderConfig; selected: Set<string>; changed(): void; manualAdded(): void }

export function createModelParametersPage(ctx: IPadSettingsContext, state: IPadProviderDraft): MobileShellPage {
  const content = settingsContent(ctx), provider = state.provider, error = settingsError(ctx);
  const protocolField = el(ctx.document, "label", "pd-settings-field"), protocol = el(ctx.document, "select", "pd-settings-input"); protocol.setAttribute("aria-label", t(ctx, "协议"));
  for (const [value, name] of [["openai-completions", "Chat Completions"], ["openai-responses", "Responses"]]) {
    const option = el(ctx.document, "option", "", name); option.value = value; protocol.append(option);
  }
  protocol.value = provider.apiProtocol;
  protocol.addEventListener("change", () => { provider.apiProtocol = protocol.value as ApiProviderConfig["apiProtocol"]; state.changed(); });
  protocolField.append(el(ctx.document, "span", "pd-settings-field-label", t(ctx, "协议")), protocol); content.append(protocolField);
  const rows = el(ctx.document, "div", "pd-model-parameters"); content.append(rows);
  const render = () => {
    rows.replaceChildren();
    for (const model of provider.models) {
      const details = el(ctx.document, "details", "pd-model-parameter"), summary = el(ctx.document, "summary", ""), name = el(ctx.document, "span", "", model.displayName || model.id); details.open = provider.models.length === 1;
      summary.append(settingsBrand(ctx, provider), name);
      const body = el(ctx.document, "div", "pd-model-parameter-fields"); details.append(summary, body); rows.append(details);
      settingsField(ctx, body, "Model ID", model.id, value => {
        const previous = model.id; model.id = value;
        if (state.selected.delete(previous)) state.selected.add(value);
        if (provider.defaultModelId === previous) provider.defaultModelId = value;
        if (model.displayName === previous) model.displayName = value;
        name.textContent = model.displayName || value; state.changed();
      });
      for (const [key, label] of [["contextWindow", "上下文窗口"], ["modelMaxTokens", "模型输出上限"], ["maxOutputTokens", "单次输出上限"]] as const) {
        const input = settingsField(ctx, body, t(ctx, label), String(model[key]), value => {
          const number = Number(value); model[key] = number; model.limitsOverride = { ...model.limitsOverride, [key]: number }; state.changed();
        }, "number"); input.min = key === "contextWindow" ? "1024" : "1"; input.step = "1";
      }
      const capabilities = settingsGroup(ctx, body, t(ctx, "能力"));
      settingsSwitch(ctx, capabilities, t(ctx, "工具调用"), model.toolCalling, checked => { model.toolCalling = checked; model.capabilityOverrides = { ...model.capabilityOverrides, toolCalling: checked }; state.changed(); });
      settingsSwitch(ctx, capabilities, t(ctx, "图片输入"), model.input.includes("image"), checked => { model.input = checked ? ["text", "image"] : ["text"]; model.capabilityOverrides = { ...model.capabilityOverrides, input: [...model.input] }; state.changed(); });
      settingsSwitch(ctx, capabilities, t(ctx, "思考"), model.reasoningEnabled, checked => { model.reasoningEnabled = checked;
        if (checked) { model.reasoning = true; model.capabilityOverrides = { ...model.capabilityOverrides, reasoning: true }; } state.changed(); });
    }
  };
  render();
  let manualId = "";
  const manual = settingsField(ctx, content, t(ctx, "手动添加 Model ID"), "", value => { manualId = value; }); manual.placeholder = "deepseek-chat";
  content.append(settingsAction(ctx, "添加", () => {
    const model: ApiProviderModelConfig = mobileModel(manualId.trim());
    try {
      validateMobileModelParameters(model);
      if (provider.models.some(item => item.id === model.id)) throw new Error("模型 ID 已存在。");
      provider.models.push(model); state.selected.add(model.id); state.manualAdded(); state.changed(); manual.value = manualId = ""; error.hidden = true; render();
    } catch (failure) { showSettingsError(error, failure); }
  }), error);
  const footer = el(ctx.document, "div", "pd-settings-actions");
  footer.append(settingsAction(ctx, "完成", async () => {
    try { provider.models.forEach(validateMobileModelParameters); error.hidden = true; await ctx.back(); }
    catch (failure) { showSettingsError(error, failure); }
  }, true));
  return { id: `ipad-model-parameters-${provider.id}`, title: t(ctx, "参数"), content, footer };
}
