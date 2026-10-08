import * as assert from "node:assert/strict";
import { App } from "obsidian";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Api, type ProviderStreams } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { createApiProviderConfig, createApiProviderModelConfig, createDiscoveredApiProviderModelConfig, applyApiProviderModelLimitsOverride, normalizeSettingsData, type ApiProviderConfig } from "../settings/settings";
import { normalizeDiscoveredProviderModel, parseProviderModelResponse } from "../settings/provider-model-discovery";
import { settingsCopy } from "../settings/i18n";
import { ProviderModelModal } from "../settings/provider-model-modal";
import { PiProviderConfigurationService, type PiProviderConfigurationDraft } from "../plugin/pi-provider-configuration-service";
import { createPiProductionModelDefinition } from "../plugin/pi-production-runtime-composition";
import { resolveComposerReasoningState } from "../ui/composer-reasoning";
import { resolveEchoInkPiModelReasoningCapabilities, resolveEchoInkPiReasoningCapabilities } from "../settings/pi-model-catalog";
import { PiProviderProtocolDispatcher, PiProviderProtocolTransport } from "../harness/pi/pi-provider-protocol-adapter";
import { assistantProviderFailureText, sanitizeProviderFailureDetail, type AssistantProviderFailure } from "../harness/pi/provider-failure";
import { deepSeekModelListFixture, syntheticDiscoveredModel } from "./provider-model-discovery-fixtures";

const key = "FAKE_DISCOVERY_KEY_DO_NOT_DISPLAY";
function settings(provider: ApiProviderConfig) {
  return normalizeSettingsData(JSON.parse(JSON.stringify({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: provider.defaultModelId }))).settings;
}
function draft(provider: ApiProviderConfig): PiProviderConfigurationDraft {
  const model = provider.models[0] ?? createApiProviderModelConfig(provider.providerId!, "", provider.runtimeProviderId);
  return { providerSettingsId: provider.id, providerId: provider.providerId!, runtimeProviderId: provider.runtimeProviderId, apiProtocol: provider.apiProtocol, authMode: provider.authMode, baseUrl: provider.baseUrl, apiKey: key, modelId: model.id, toolCalling: model.toolCalling, reasoning: model.reasoning, imageInput: model.input.includes("image"), contextWindow: model.contextWindow, modelMaxTokens: model.modelMaxTokens, maxOutputTokens: model.maxOutputTokens };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function control(modal: ProviderModelModal, focusKey: string): HTMLInputElement {
  const element = modal.contentEl.querySelector<HTMLInputElement>(`[data-modal-focus-key="${focusKey}"]`);
  assert.ok(element, focusKey);
  return element;
}
type InspectModal = { draft: ApiProviderConfig; selectProvider(id: string): void; discoverModels(): Promise<void>; setModelEnabled(id: string, enabled: boolean): void };

export async function runProviderModelDiscoveryRegression(installDom: () => void): Promise<void> {
  assert.equal(normalizeDiscoveredProviderModel({ id: "fixture-model", displayName: "模\0型\u007f名称\u0085" })?.displayName, "模型名称");
  installDom();
  const provider = createApiProviderConfig("deepseek", "discovery-fixture");
  provider.apiKey = key;
  let response: unknown = deepSeekModelListFixture;
  let httpStatus = 200;
  const service = new PiProviderConfigurationService({ settings: settings(provider) }, { fetchImpl: async () => ({ status: httpStatus, json: async () => response }) });
  let saved: ApiProviderConfig | undefined;
  const modal = new ProviderModelModal({ app: new App(), draft: provider, editing: false, language: "zh-CN", copy: settingsCopy("zh-CN"), preflight: service, save: async (value, apiKey) => { saved = { ...structuredClone(value), apiKey: apiKey || value.apiKey }; return { saved: true }; } });
  modal.open();
  const inspect = modal as unknown as InspectModal;
  assert.equal(inspect.draft.models.length, 0);
  inspect.selectProvider("custom"); inspect.selectProvider("deepseek");
  assert.equal(inspect.draft.models.length, 0, "switching provider on a new draft cannot enable old presets");
  const input = control(modal, "apiKey"); input.value = key; input.oninput?.(new Event("input"));
  control(modal, "model-discover").click(); await flush();
  assert.equal(modal.contentEl.querySelectorAll(".codex-provider-model-choice").length, 2);
  assert.match(modal.contentEl.textContent ?? "", /DeepSeek-V4.1-Flash/u);
  assert.match(modal.contentEl.textContent ?? "", /deepseek-flash/u);
  const choose = control(modal, "model-enabled:deepseek-flash"); choose.checked = true; choose.onchange?.(new Event("change"));
  const selected = inspect.draft.models[0]!;
  assert.deepEqual(selected.input, ["text", "image"]);
  assert.equal(selected.toolCalling, true);
  assert.equal(selected.contextWindow, 1048576);
  assert.equal(selected.modelMaxTokens, 393216);
  const composer = resolveComposerReasoningState({ apiProviders: [inspect.draft] }, provider.id, selected.id)!;
  assert.deepEqual(composer.enabledOptions.map((option) => option.effort), ["low", "high", "max"]);
  assert.equal(composer.effort, "high");
  control(modal, "save").click(); await flush();
  assert.ok(saved);
  const reopened = settings(saved!);
  assert.deepEqual(reopened.apiProviders[0]!.models[0]!.discovery, selected.discovery);
  const production = createPiProductionModelDefinition(reopened);
  assert.equal(production.maxTokens, 393216);
  assert.deepEqual(production.input, ["text", "image"]);
  assert.deepEqual(resolveEchoInkPiModelReasoningCapabilities(production).enabledOptions.map((option) => option.effort), ["low", "high", "max"]);
  assert.equal(resolveEchoInkPiModelReasoningCapabilities(production).defaultEffort, "high");
  console.log("PASS discovery: new DeepSeek → two remote IDs → select/save/reopen → production metadata and exact reasoning levels");

  const synthetic = parseProviderModelResponse({ data: [syntheticDiscoveredModel] })!.models[0]!;
  const custom = createApiProviderConfig("custom", "synthetic-provider"); custom.apiKey = key; custom.baseUrl = "https://fixture.invalid/v1";
  custom.models = [createDiscoveredApiProviderModelConfig("custom", synthetic.id, custom.runtimeProviderId, synthetic)];
  custom.defaultModelId = synthetic.id;
  const syntheticReopened = settings(custom);
  const syntheticRuntime = createPiProductionModelDefinition(syntheticReopened);
  assert.equal(syntheticRuntime.name, "Future Model 2030");
  assert.equal(syntheticRuntime.contextWindow, 131072);
  assert.equal(syntheticRuntime.maxTokens, 32768);
  assert.equal(JSON.stringify(syntheticRuntime).includes("MUST_NOT_REACH_PAYLOAD"), false);
  console.log("PASS discovery: uncatalogued synthetic ID persists and drives the production model");

  const noLevels = createDiscoveredApiProviderModelConfig("kimi", "kimi-k2-turbo-preview", "moonshotai-cn", { id: "kimi-k2-turbo-preview", reasoning: true });
  assert.equal(resolveComposerReasoningState({ apiProviders: [{ ...custom, runtimeProviderId: "moonshotai-cn", models: [noLevels] }] }, custom.id, noLevels.id)!.supported, true);
  const knownNoLevels = createDiscoveredApiProviderModelConfig("deepseek", "deepseek-v4-pro", "deepseek", { id: "deepseek-v4-pro", reasoning: true });
  const knownCapabilities = resolveEchoInkPiModelReasoningCapabilities(createPiProductionModelDefinition(settings({ ...provider, models: [knownNoLevels], defaultModelId: knownNoLevels.id })));
  const catalogCapabilities = resolveEchoInkPiReasoningCapabilities("deepseek", knownNoLevels.id, true);
  assert.deepEqual(knownCapabilities.enabledOptions, catalogCapabilities.enabledOptions);
  assert.equal(knownCapabilities.defaultEffort, catalogCapabilities.defaultEffort);
  const falseModel = createDiscoveredApiProviderModelConfig("deepseek", "deepseek-v4-pro", "deepseek", { id: "deepseek-v4-pro", input: ["text"], toolCalling: false, reasoning: false });
  assert.equal(falseModel.reasoning, false);
  assert.equal(falseModel.toolCalling, false);
  const falseProvider = { ...provider, models: [falseModel], defaultModelId: falseModel.id };
  assert.equal(resolveComposerReasoningState({ apiProviders: [falseProvider] }, provider.id, falseModel.id)!.supported, false);
  const falseRuntime = createPiProductionModelDefinition(settings(falseProvider));
  assert.equal(falseRuntime.reasoning, false);
  assert.deepEqual(falseRuntime.input, ["text"]);
  const manual = custom.models[0]!;
  manual.toolCalling = false; manual.capabilityOverrides = { toolCalling: false }; manual.metadataSource = "manual"; manual.reasoningEnabled = false; manual.reasoningEffort = "max";
  applyApiProviderModelLimitsOverride(manual, "custom", custom.runtimeProviderId, { contextWindow: 100000, maxOutputTokens: 16000 });
  const refreshed = createDiscoveredApiProviderModelConfig("custom", manual.id, custom.runtimeProviderId, { ...synthetic, input: ["text"], contextWindow: 150000 }, manual);
  assert.equal(refreshed.toolCalling, false); assert.deepEqual(refreshed.input, ["text"]);
  assert.equal(refreshed.contextWindow, 100000); assert.equal(refreshed.maxOutputTokens, 16000);
  assert.equal(refreshed.reasoningEnabled, false); assert.equal(refreshed.reasoningEffort, "max");
  const roundtrip = settings({ ...custom, models: [refreshed] }).apiProviders[0]!.models[0]!;
  assert.deepEqual(roundtrip, refreshed);
  assert.equal(parseProviderModelResponse({ data: [{ id: "id-only" }] })!.models[0]!.reasoning, undefined);
  assert.equal(parseProviderModelResponse({ data: [], has_more: true })!.incomplete, true);
  assert.equal(parseProviderModelResponse({ data: Array.from({ length: 201 }, (_, i) => ({ id: `model-${i}` })) })!.incomplete, true);
  console.log("PASS discovery: explicit false, declared true without levels, ID-only unknown, partial lists, field overrides and preferences");

  const edit = new ProviderModelModal({ app: new App(), draft: { ...saved!, providerId: "custom", runtimeProviderId: "custom", name: "custom", baseUrl: "https://fixture.invalid/v1" }, editing: true, language: "zh-CN", copy: settingsCopy("zh-CN"), preflight: service, save: async () => ({ saved: true }) }); edit.open();
  const editable = edit as unknown as InspectModal;
  response = { data: [{ id: "another-model" }] }; await editable.discoverModels();
  assert.equal(editable.draft.defaultModelId, "deepseek-flash");
  assert.match(edit.contentEl.textContent ?? "", /此次列表未返回/u);
  response = { data: [] }; await editable.discoverModels();
  assert.equal(edit.contentEl.querySelectorAll(".codex-provider-model-choice").length, 1);
  httpStatus = 503; await editable.discoverModels();
  assert.equal(control(edit, "model-enabled:deepseek-flash").checked, true);
  httpStatus = 200; response = deepSeekModelListFixture; await editable.discoverModels();
  const beforeIdentity = editable.draft.models[0]!;
  beforeIdentity.toolCalling = false; beforeIdentity.capabilityOverrides = { toolCalling: false }; beforeIdentity.metadataSource = "manual";
  applyApiProviderModelLimitsOverride(beforeIdentity, "custom", "custom", { maxOutputTokens: 16000 });
  const endpoint = control(edit, "endpoint"); endpoint.value = "https://new.example/v1"; endpoint.oninput?.(new Event("input"));
  assert.equal((edit as any).preflight.state.models.length, 0);
  assert.equal(edit.contentEl.querySelectorAll(".codex-provider-model-choice").length, 1, "old unselected remote choices disappear immediately after endpoint input");
  assert.equal(editable.draft.models[0]!.discovery, undefined);
  assert.match(edit.contentEl.textContent ?? "", /手动值 16,000 已保留/u);
  assert.equal(editable.draft.defaultModelId, "deepseek-flash");
  const identityReopened = settings(editable.draft).apiProviders[0]!.models[0]!;
  assert.deepEqual(identityReopened.capabilityOverrides, { toolCalling: false });
  assert.equal(identityReopened.limitsOverride?.maxOutputTokens, 16000);
  const rediscovered = createDiscoveredApiProviderModelConfig("custom", identityReopened.id, "custom", { id: identityReopened.id, input: ["text", "image"], reasoning: false, modelMaxTokens: 50000 }, identityReopened);
  assert.deepEqual(rediscovered.input, ["text", "image"]);
  assert.equal(rediscovered.reasoning, false);
  assert.equal(rediscovered.toolCalling, false);
  assert.equal(rediscovered.maxOutputTokens, 16000);
  await editable.discoverModels();
  const credential = control(edit, "apiKey"); credential.value = "ANOTHER_FAKE_KEY"; credential.oninput?.(new Event("input"));
  assert.equal((edit as any).preflight.state.models.length, 0);
  assert.equal(edit.contentEl.querySelectorAll(".codex-provider-model-choice").length, 1);
  await editable.discoverModels();
  const protocol = control(edit, "protocol"); protocol.value = "openai-responses"; protocol.onchange?.(new Event("change"));
  assert.equal((edit as any).preflight.state.models.length, 0);
  assert.equal(edit.contentEl.querySelectorAll(".codex-provider-model-choice").length, 1);
  edit.close();
  console.log("PASS discovery: refresh/empty/failure preserve saved default; endpoint changes clear stale discovery");

  const originalFetch = globalThis.fetch;
  const captured: Record<string, any>[] = [];
  globalThis.fetch = async (_input, init) => {
    captured.push(JSON.parse(String(init?.body)));
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] };
    const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const dispatcher = new PiProviderProtocolDispatcher();
    const tool = { name: "fixture_read", description: "Read fixture", parameters: { type: "object", properties: {} } };
    const context: Context = { messages: [{ role: "user", content: "fixture", timestamp: 1 }], tools: [tool] };
    for (const modelId of ["deepseek-v4-flash", "deepseek-flash"]) {
      const model = modelId === "deepseek-flash" ? production : createPiProductionModelDefinition(settings(provider));
      for (const reasoning of ["off", "high"] as const) {
        const result = await dispatcher.stream({ model, context, apiKey: key, options: { reasoning, maxTokens: model.maxTokens, maxRetries: 0, timeoutMs: 1000 } }).result();
        assert.equal(result.stopReason, "stop");
        const payload = captured.at(-1)!;
        assert.equal(payload.max_tokens, model.maxTokens); assert.equal(Object.hasOwn(payload, "max_completion_tokens"), false);
        assert.deepEqual(payload.thinking, { type: reasoning === "off" ? "disabled" : "enabled" });
        assert.equal(payload.tools[0].function.name, "fixture_read");
      }
    }
    const previous: AssistantMessage = { role: "assistant", api: production.api, provider: production.provider, model: production.id, timestamp: 2, stopReason: "toolUse", content: [{ type: "thinking", thinking: "fixture reasoning", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "call_1", name: "fixture_read", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    await dispatcher.stream({ model: production, context: { messages: [...context.messages, previous, { role: "toolResult", toolCallId: "call_1", toolName: "fixture_read", content: [{ type: "text", text: "fixture result" }], timestamp: 3, isError: false }], tools: [tool] }, apiKey: key, options: { reasoning: "high", maxTokens: 100, maxRetries: 0 } }).result();
    assert.equal(captured.at(-1)!.messages.find((message: any) => message.role === "assistant").reasoning_content, "fixture reasoning");
    await dispatcher.stream({ model: syntheticRuntime, context, apiKey: key, options: { reasoning: "high", maxTokens: 16000, maxRetries: 0 } }).result();
    assert.equal(captured.at(-1)!.max_tokens, 16000);
  } finally { globalThis.fetch = originalFetch; }
  console.log("PASS wire: actual Pi SDK payloads for old/new DeepSeek off/on, tools and reasoning tool-result continuation; generic output unchanged");

  const reasons: string[] = [];
  for (const param of ["max_completion_tokens", "reasoning_effort"]) {
    const adapter: ProviderStreams = {
      stream: (_model, _context, options) => {
        const output = createAssistantMessageEventStream();
        void (async () => {
          await options?.onResponse?.({ status: 400, headers: {} } as never);
          output.push({ type: "error", reason: "error", error: { ...productionAssistant(production), stopReason: "error", errorMessage: JSON.stringify({ error: { code: "invalid_request_error", param, message: `Unsupported parameter ${param}; Authorization: Bearer ${key}`, request: { content: "PRIVATE_REQUEST_CANARY" } } }) } });
        })();
        return output;
      },
      streamSimple: () => { throw new Error("fixture expects stream"); }
    };
    // streamSimple dispatcher invokes the adapter's streamSimple; share the same controlled response.
    adapter.streamSimple = adapter.stream;
    const transport = new PiProviderProtocolTransport({ authorityId: "fixture", storeSetId: "fixture", resolveAuthToken: () => key, dispatcher: new PiProviderProtocolDispatcher({ "openai-completions": adapter }) });
    const result = await (await transport.stream({ runId: "fixture", turnId: "fixture", conversationId: "fixture", correlationId: "fixture", provider: { providerId: production.provider, modelRef: production.id, baseUrl: production.baseUrl, apiProtocol: "openai-completions", authMode: "api-key" }, model: production, context: { messages: [] }, options: { temperature: 0, cacheRetention: "none", maxRetries: 0, timeoutMs: 1000 } })).result() as AssistantProviderFailure;
    assert.equal(result.errorMessage, "provider_request_rejected");
    assert.equal(result.echoInkProviderFailure?.status, 400);
    assert.equal(result.echoInkProviderFailure?.param, param);
    assert.equal(isRetryableAssistantError(result), false);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_DISCOVERY_KEY|PRIVATE_REQUEST_CANARY|Authorization|Bearer/u);
    reasons.push(assistantProviderFailureText(result));
  }
  assert.notEqual(reasons[0], reasons[1]);
  assert.deepEqual(sanitizeProviderFailureDetail(400, { error: { param: key, code: key } }, [key]), { status: 400 });
  assert.deepEqual(sanitizeProviderFailureDetail(null, '400 {"error":{"code":"invalid_request_error","param":"max_tokens","message":"Unsupported parameter max_tokens"}}', [key]), { status: 400, code: "invalid_request_error", param: "max_tokens", reason: "unsupported" });
  console.log("PASS errors: distinct actionable parameters and HTTP status; no raw body/Key/Authorization; stable retry category");
}

function productionAssistant(model: Model<Api>): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: "stop", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
