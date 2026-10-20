import { requestUrl } from "obsidian";
import type { ApiProviderConfig, ApiProviderModelConfig } from "../settings/settings";
import { apiProviderModelsUrl, normalizeApiProviderBaseUrl, type ApiProviderId } from "../settings/provider-presets";
import { parseProviderModelResponse } from "../settings/provider-model-discovery";
import { mobileModel, mobileProvider, supportedProvider, type MobileSettings } from "./settings";
import { mobileGenerateText, type MobileRequest, type MobileUsageObserver } from "./transport";

export const MOBILE_MODEL_GROUPS: readonly { title: string; ids: readonly ApiProviderId[] }[] = [
  { title: "API Key", ids: ["glm", "kimi", "deepseek", "qwen"] },
  { title: "套餐", ids: ["qwen-token-plan"] },
  { title: "其他", ids: ["custom"] }
];
export const MOBILE_MODEL_REQUEST_TIMEOUT_MS = 20_000;

// Both endpoint views may own a service; writes still share one settings queue.
const writes = new WeakMap<MobileSettings, Promise<void>>();
const copy = <T>(value: T): T => structuredClone(value);
const fingerprint = (value: unknown): string => JSON.stringify(value);
const conflict = () => new Error("模型服务已在其他位置修改，请重新打开后编辑；当前草稿已保留。");

export function validateMobileModelParameters(model: ApiProviderModelConfig): void {
  if (typeof model.id !== "string" || !/^[^\s\p{Cc}]{1,256}$/u.test(model.id)) throw new Error("请填写有效的模型 ID（最多 256 字符，不能含空白）。");
  if (typeof model.displayName !== "string" || !model.displayName.trim()) throw new Error("请填写模型名称。");
  const limits = [["contextWindow", "上下文窗口", 1024, 2_000_000], ["modelMaxTokens", "模型输出上限", 1, 1_000_000], ["maxOutputTokens", "单次输出上限", 1, 1_000_000]] as const;
  for (const [key, label, min, max] of limits) {
    const value = model[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min}–${max} 的整数。`);
    const override = model.limitsOverride?.[key];
    if (override !== undefined && (!Number.isSafeInteger(override) || override < min || override > max)) throw new Error(`${label}的调用上限无效。`);
  }
  if (model.maxOutputTokens > Math.min(model.contextWindow, model.modelMaxTokens)) throw new Error("单次输出上限不能超过上下文窗口或模型输出上限。");
  if (!Array.isArray(model.input) || !model.input.includes("text") || model.input.some(input => input !== "text" && input !== "image")) throw new Error("模型必须支持文字输入。");
  if ([model.toolCalling, model.reasoning, model.reasoningEnabled].some(value => typeof value !== "boolean") || (model.reasoningEnabled && !model.reasoning)) throw new Error("请检查工具调用和思考设置。");
  if (model.reasoningEffort !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(model.reasoningEffort)) throw new Error("请选择有效的思考强度。");
}

function validateConnection(provider: ApiProviderConfig): void {
  if (!supportedProvider(provider)) throw new Error("此服务仅支持电脑端，请选择移动端可用的 API Key 服务。");
  try { normalizeApiProviderBaseUrl(provider.baseUrl, provider.apiProtocol); }
  catch { throw new Error("请填写有效的 HTTPS 接口地址。"); }
  if (!provider.apiKey.trim()) throw new Error("请填写 API Key。");
}

function checkResponse(status: number): void {
  if (status === 401 || status === 403) throw new Error("API Key 验证失败，请检查后重试。");
  if (status === 429) throw new Error("请求过于频繁，请稍后重试。");
  if (status >= 500) throw new Error("模型服务暂时不可用，请稍后重试。");
  if (status < 200 || status >= 300) throw new Error(`模型服务请求失败（${status}），请检查接口和模型。`);
}

export class MobileModelConfiguration {
  private readonly baselines = new Map<string, ApiProviderConfig>();
  private readonly drafts = new WeakMap<ApiProviderConfig, ApiProviderConfig | null>();
  private readonly fetching = new Map<string, { key: string; promise: Promise<{ models: ApiProviderModelConfig[]; incomplete: boolean }> }>();
  private readonly saving = new WeakMap<ApiProviderConfig, Promise<void>>();

  constructor(private readonly settings: () => MobileSettings, private readonly saveSettings: () => Promise<void>, private readonly request: MobileRequest = requestUrl, private readonly usage?: MobileUsageObserver) {
    for (const provider of settings().apiProviders) this.baselines.set(provider.id, copy(provider));
  }

  /** Retain this object through parameter pages and pass it unchanged to save. */
  createDraft(providerOrId?: ApiProviderConfig | string): ApiProviderConfig {
    const provider = typeof providerOrId === "string" ? this.settings().apiProviders.find(item => item.id === providerOrId) : providerOrId;
    if (typeof providerOrId === "string" && !provider) throw conflict();
    const draft = copy(provider ?? mobileProvider("custom"));
    const current = this.settings().apiProviders.find(item => item.id === draft.id);
    this.drafts.set(draft, current ? copy(provider ?? current) : null);
    return draft;
  }

  fetchModels(provider: ApiProviderConfig): Promise<{ models: ApiProviderModelConfig[]; incomplete: boolean }> {
    try { validateConnection(provider); } catch (error) { return Promise.reject(error); }
    const draft = copy(provider), key = fingerprint(draft);
    const previous = this.fetching.get(draft.id);
    if (previous?.key === key) return previous.promise;
    const entry = { key, promise: Promise.resolve({ models: [] as ApiProviderModelConfig[], incomplete: false }) };
    entry.promise = this.timed(async () => {
      const url = new URL(apiProviderModelsUrl(draft.baseUrl, draft.apiProtocol));
      for (const [name, value] of Object.entries(draft.queryParams ?? {})) url.searchParams.set(name, value);
      const response = await this.checkedRequest({ url: url.toString(), method: "GET", headers: { Authorization: `Bearer ${draft.apiKey.trim()}` }, throw: false });
      const parsed = parseProviderModelResponse(response.json);
      if (!parsed) throw new Error("模型服务返回格式错误，请重试或手动填写模型 ID。");
      if (this.fetching.get(draft.id) !== entry || fingerprint(provider) !== key) throw new Error("服务信息已变更，请重新获取模型。");
      return { incomplete: parsed.incomplete, models: parsed.models.map(discovery => {
        const existing = draft.models.find(model => model.id === discovery.id);
        const model = mobileModel(discovery.id, { ...discovery, ...existing, discovery, metadataSource: existing?.metadataSource ?? "discovery" } as ApiProviderModelConfig);
        if (!existing) {
          model.reasoningEnabled = model.reasoning;
          model.maxOutputTokens = Math.min(model.maxOutputTokens, model.contextWindow, model.modelMaxTokens);
        }
        return model;
      }) };
    }).finally(() => { if (this.fetching.get(draft.id) === entry) this.fetching.delete(draft.id); });
    this.fetching.set(draft.id, entry);
    return entry.promise;
  }

  save(provider: ApiProviderConfig): Promise<void> {
    const pending = this.saving.get(provider);
    if (pending) return pending;
    const inputKey = fingerprint(provider), draft = copy(provider);
    const baseline = this.drafts.has(provider) ? this.drafts.get(provider) ?? null : this.baselines.get(draft.id) ?? null;
    const saving = this.enqueue(async settings => {
      validateConnection(draft);
      if (!draft.id || !draft.name.trim()) throw new Error("请填写服务名称。");
      if (!draft.models.length) throw new Error("请至少选择一个模型。");
      draft.models.forEach(validateMobileModelParameters);
      if (new Set(draft.models.map(model => model.id)).size !== draft.models.length) throw new Error("模型 ID 不能重复。");
      const current = () => settings.apiProviders.find(item => item.id === draft.id) ?? null;
      if (fingerprint(current()) !== fingerprint(baseline)) throw conflict();
      draft.baseUrl = normalizeApiProviderBaseUrl(draft.baseUrl, draft.apiProtocol);
      const model = draft.models.find(item => item.id === (settings.activeApiProviderId === draft.id ? settings.defaultModel : draft.defaultModelId))
        ?? draft.models.find(item => item.id === draft.defaultModelId) ?? draft.models[0];
      draft.defaultModelId = model.id;
      await this.timed(async signal => {
        let requestFailure: Error | undefined;
        try {
          const text = await mobileGenerateText(draft, { ...model, reasoningEnabled: false }, async request => {
            try { return await this.checkedRequest(request); }
            catch (error) { requestFailure = error as Error; throw error; }
          }, "Connection check. Reply with OK only.", "只回复 OK", 32, signal, this.usage, "connection-test");
          if (!text.trim()) throw new Error("连接测试未返回有效内容，请检查模型。");
        } catch {
          throw requestFailure ?? new Error("连接测试失败，请检查接口与模型后重试。");
        }
      });
      if (fingerprint(current()) !== fingerprint(baseline) || fingerprint(provider) !== inputKey || this.settings() !== settings) throw conflict();
      // Fields omitted by an endpoint editor must not remove stored extensions.
      const next = { ...baseline, ...draft, models: draft.models.map(model => ({ ...baseline?.models.find(item => item.id === model.id), ...model })) };
      await this.persist(settings, draft.id, next);
      this.baselines.set(draft.id, copy(next));
      this.drafts.set(provider, copy(next));
    }).finally(() => this.saving.delete(provider));
    this.saving.set(provider, saving);
    return saving;
  }

  selectDefault(providerSettingsId: string, modelId: string): Promise<void> {
    return this.enqueue(async settings => {
      const provider = settings.apiProviders.find(item => item.id === providerSettingsId);
      if (!provider || !supportedProvider(provider) || !provider.models.some(model => model.id === modelId)) throw new Error("此模型当前不可用，请重新选择。");
      await this.persist(settings, providerSettingsId, provider, { provider: providerSettingsId, model: modelId });
    });
  }

  remove(id: string): Promise<void> {
    const baseline = copy(this.settings().apiProviders.find(provider => provider.id === id) ?? null);
    return this.enqueue(async settings => {
      if (fingerprint(settings.apiProviders.find(provider => provider.id === id) ?? null) !== fingerprint(baseline)) throw conflict();
      if (!baseline) return;
      await this.persist(settings, id, null);
      this.baselines.delete(id);
    });
  }

  private enqueue(operation: (settings: MobileSettings) => Promise<void>): Promise<void> {
    const settings = this.settings();
    const pending = (writes.get(settings) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.settings() !== settings) throw conflict();
      await operation(settings);
    });
    writes.set(settings, pending);
    return pending;
  }

  private async persist(settings: MobileSettings, id: string, provider: ApiProviderConfig | null, selection?: { provider: string; model: string }): Promise<void> {
    const index = settings.apiProviders.findIndex(item => item.id === id), previous = index >= 0 ? settings.apiProviders[index] : null;
    const previousSelection = { provider: settings.activeApiProviderId, model: settings.defaultModel };
    const hadProviderMode = Object.hasOwn(settings, "providerMode"), previousMode = settings.providerMode;
    const appliedProviderKey = fingerprint(provider);
    if (provider) {
      if (index >= 0) settings.apiProviders[index] = provider; else settings.apiProviders.push(provider);
    } else if (index >= 0) settings.apiProviders.splice(index, 1);
    const active = settings.apiProviders.find(item => item.id === settings.activeApiProviderId && supportedProvider(item));
    if (selection) { settings.activeApiProviderId = selection.provider; settings.defaultModel = selection.model; }
    else if (!active?.models.some(model => model.id === settings.defaultModel)) {
      const next = active?.models.length ? active : settings.apiProviders.find(item => supportedProvider(item) && item.models.length);
      settings.activeApiProviderId = next?.id ?? "";
      settings.defaultModel = next?.models.find(model => model.id === next.defaultModelId)?.id ?? next?.models[0]?.id ?? "";
    }
    settings.providerMode = "api";
    const appliedSelection = { provider: settings.activeApiProviderId, model: settings.defaultModel };
    try { await this.saveSettings(); }
    catch {
      // Restore only our own mutation; unrelated settings/edits may have advanced.
      const current = settings.apiProviders.findIndex(item => item.id === id);
      if (fingerprint(current >= 0 ? settings.apiProviders[current] : null) === appliedProviderKey) {
        if (previous) { if (current >= 0) settings.apiProviders[current] = previous; else settings.apiProviders.splice(Math.max(0, index), 0, previous); }
        else if (current >= 0) settings.apiProviders.splice(current, 1);
      }
      if (settings.activeApiProviderId === appliedSelection.provider && settings.defaultModel === appliedSelection.model) {
        settings.activeApiProviderId = previousSelection.provider; settings.defaultModel = previousSelection.model;
      }
      if (settings.providerMode === "api") {
        if (hadProviderMode) settings.providerMode = previousMode; else delete settings.providerMode;
      }
      throw new Error("设置保存失败，当前草稿已保留，请重试。");
    }
  }

  private async checkedRequest(request: Parameters<MobileRequest>[0]): ReturnType<MobileRequest> {
    let response: Awaited<ReturnType<MobileRequest>>;
    try { response = await this.request(request); }
    catch { throw new Error("网络请求失败，请检查连接后重试。"); }
    checkResponse(response.status);
    try { return { status: response.status, json: response.json }; }
    catch { throw new Error("模型服务返回格式错误，请重试或手动填写模型 ID。"); }
  }

  private async timed<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("模型服务请求超时，请重试。")); }, MOBILE_MODEL_REQUEST_TIMEOUT_MS);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
