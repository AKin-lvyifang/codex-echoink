import * as assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { App } from "obsidian";
import {
  apiProviderModelUsesAutoOutputLimit, apiProviderModelAutomaticOutputTarget,
  applyApiProviderModelLimitsOverride, createApiProviderConfig, createApiProviderModelConfig,
  createDiscoveredApiProviderModelConfig, DEFAULT_SETTINGS, normalizeSettingsData,
  type ApiProviderConfig, type ApiProviderModelConfig
} from "../settings/settings";
import { calculatePiEffectiveInputBudget } from "../harness/pi-native/pi-effective-input-budget";
import { createConfiguredPiAutoOutputLimitPolicy } from "../plugin/configured-pi-provider-dispatcher";
import { ProviderModelModal } from "../settings/provider-model-modal";
import { settingsCopy } from "../settings/i18n";

export async function runProviderAutoLimitSettingsTests(): Promise<void> {
  const unknown = () => createApiProviderModelConfig("custom", "auto-output-fixture");
  const isAuto = (model: ApiProviderModelConfig, providerId: "custom" | "deepseek" | "qwen-token-plan" = "custom") => apiProviderModelUsesAutoOutputLimit(providerId, model);
  const model = unknown();
  assert.equal(isAuto(model), true);
  assert.deepEqual([model.contextWindow, model.modelMaxTokens, model.maxOutputTokens], [64_000, 8_192, 8_192]);
  assert.equal(calculatePiEffectiveInputBudget({ contextWindow: model.contextWindow, maxOutputReserve: model.maxOutputTokens }).effectiveInputBudget, 48_000);
  assert.equal(apiProviderModelAutomaticOutputTarget(model), 262_144);
  assert.equal(isAuto(createApiProviderModelConfig("deepseek", "deepseek-flash"), "deepseek"), false);
  assert.equal(isAuto(createApiProviderModelConfig("qwen-token-plan", "qwen3.7-plus"), "qwen-token-plan"), false);
  assert.equal(isAuto(createDiscoveredApiProviderModelConfig("custom", model.id, "echoink-custom", { id: model.id })), true);
  assert.equal(isAuto(createDiscoveredApiProviderModelConfig("custom", model.id, "echoink-custom", { id: model.id, modelMaxTokens: 65_536 })), false);
  assert.equal(isAuto({ ...model, metadataSource: "manual", capabilityOverrides: { toolCalling: true } }), true);
  applyApiProviderModelLimitsOverride(model, "custom", "echoink-custom", { maxOutputTokens: 8_192, contextWindow: 64_000, modelMaxTokens: 8_192 });
  assert.deepEqual(model.limitsOverride, { maxOutputTokens: 8_192, contextWindow: 64_000, modelMaxTokens: 8_192 });
  assert.equal(isAuto(model), false);
  applyApiProviderModelLimitsOverride(model, "custom", "echoink-custom", undefined);
  assert.equal(isAuto(model), true);

  const provider = createApiProviderConfig("custom", "auto-limit-settings");
  provider.apiKey = "fixture-key";
  provider.baseUrl = "https://fixture.invalid/v1";
  provider.models = [unknown()]; provider.defaultModelId = model.id;
  const load = (p: ApiProviderConfig) => normalizeSettingsData(JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, providerMode: "custom-api", activeApiProviderId: p.id, defaultModel: p.defaultModelId, apiProviders: [p] }))).settings;
  for (const source of ["discovery", "unknown"] as const) {
    const deepseek = createApiProviderConfig("deepseek");
    deepseek.models = [{ ...unknown(), id: "deepseek-flash", metadataSource: source, contextWindow: 64_000, modelMaxTokens: source === "unknown" ? 8_192 : 393_216, maxOutputTokens: source === "unknown" ? 8_192 : 393_216 }];
    deepseek.defaultModelId = "deepseek-flash";
    const restored = load(deepseek).apiProviders[0]!.models[0]!;
    assert.deepEqual([restored.contextWindow, restored.modelMaxTokens, restored.maxOutputTokens, restored.input], [1_048_576, 393_216, 393_216, ["text", "image"]]);
  }
  for (const contextWindow of [32_768, 131_072]) {
    provider.models[0]!.autoLimits = { maxOutputTokens: 65_536, contextWindow };
    const reopened = load(provider).apiProviders[0]!.models[0]!;
    assert.deepEqual(reopened.autoLimits, { maxOutputTokens: 65_536, contextWindow });
    assert.equal(reopened.contextWindow, Math.min(contextWindow, 64_000));
    assert.equal(reopened.maxOutputTokens, 8_192);
  }
  provider.models[0]!.autoLimits = { maxOutputTokens: -1, contextWindow: Number.NaN };
  assert.equal(load(provider).apiProviders[0]!.models[0]!.autoLimits, undefined);
  delete provider.models[0]!.autoLimits;
  let saves = 0;
  const host = { settings: load(provider), saveSettings: async () => { saves++; } };
  const current = host.settings.apiProviders[0]!;
  const requestModel = { id: model.id } as Model<Api>;
  const policy = createConfiguredPiAutoOutputLimitPolicy(host, current, model.id);
  assert.deepEqual(policy.read(requestModel), {});
  await policy.remember(requestModel, { maxOutputTokens: 65_536 });
  assert.equal(saves, 1);
  assert.deepEqual(load(current).apiProviders[0]!.models[0]!.autoLimits, { maxOutputTokens: 65_536 });
  current.baseUrl = "https://changed.invalid/v1";
  await policy.remember(requestModel, { maxOutputTokens: 8_192 });
  assert.equal(saves, 1, "stale endpoint cannot receive a late cache write");

  for (const identity of ["key", "url", "protocol"] as const) {
    const p = structuredClone(provider); p.models[0]!.autoLimits = { maxOutputTokens: 65_536 };
    const modal = new ProviderModelModal({ app: new App(), draft: p, editing: true, language: "zh-CN", copy: settingsCopy("zh-CN"), preflight: { listModels: async () => ({ status: "available", source: "remote", models: [] }), testConnection: async () => ({ status: "available" }) }, save: async () => ({ saved: true }) });
    const inspect = modal as unknown as { draft: ApiProviderConfig; invalidatePreflight(identityChanged: boolean): void; renderModelNumberField(parent: HTMLElement, value: ApiProviderModelConfig, key: string, label: string, min: number, max: number): void };
    modal.open();
    const m = inspect.draft.models[0]!;
    const field = modal.contentEl.createDiv();
    inspect.renderModelNumberField(field, m, "maxOutputTokens", "单次输出上限", 1, 1_000_000);
    const input = field.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.getAttribute("placeholder")?.replace(/\D/gu, ""), "65536");
    input.value = "8192"; input.oninput?.(new Event("input"));
    assert.equal(m.limitsOverride?.maxOutputTokens, 8_192);
    input.value = ""; input.oninput?.(new Event("input"));
    assert.equal(m.limitsOverride?.maxOutputTokens, undefined);
    if (identity === "url") inspect.draft.baseUrl = "https://new.invalid/v1";
    if (identity === "protocol") inspect.draft.apiProtocol = "openai-responses";
    const previousCard = modal.contentEl.querySelector(".provider-model-card");
    assert.ok(previousCard);
    inspect.invalidatePreflight(true);
    assert.equal(inspect.draft.models[0]!.autoLimits, undefined, `${identity} invalidates unknown-model cache`);
    assert.notEqual(modal.contentEl.querySelector(".provider-model-card"), previousCard, "visible automatic target refreshes with its owning model record");
    modal.close();
  }
  console.log("PASS automatic output settings: provenance, unchanged 48000 input budget, explicit 8192, preset recovery, persistence, invalidation and field display");
}
