export const API_PROVIDER_IDS = [
  "openai-codex",
  "glm",
  "kimi",
  "minimax",
  "deepseek",
  "qwen",
  "qwen-token-plan",
  "ollama",
  "custom",
  // Compatibility-only OpenAI identity remains readable so an existing saved
  // configuration is never destroyed by a settings migration.
  "openai",
  "anthropic"
] as const;

export type ApiProviderId = typeof API_PROVIDER_IDS[number];

export const API_PROVIDER_PROTOCOLS = [
  "openai-codex-responses",
  "openai-responses",
  "openai-completions",
  "anthropic-messages"
] as const;

export type ApiProviderProtocol =
  typeof API_PROVIDER_PROTOCOLS[number];

export type ApiProviderAuthMode = "api-key" | "oauth";

export type ApiProviderGroupId =
  | "account"
  | "provider"
  | "token-plan"
  | "other";

const KIMI_K2_CONTEXT_WINDOW = 262_144;
const KIMI_MAX_OUTPUT_RESERVE = 65_536;
export const QWEN_TOKEN_PLAN_API_BASE_URL =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const QWEN_TOKEN_PLAN_API_HOST = "token-plan.cn-beijing.maas.aliyuncs.com";
const QWEN_TOKEN_PLAN_API_BASE_PATH = "/compatible-mode/v1";

export interface ApiProviderModelPreset {
  readonly id: string;
  /** A human-readable product name when the provider publishes one. */
  readonly displayName?: string;
  readonly contextWindow: number;
  /** Provider-published model capability retained in Pi model metadata. */
  readonly modelMaxTokens: number;
  /** EchoInk's actual per-request output ceiling and input-budget reserve. */
  readonly maxOutputTokens: number;
  readonly toolCalling: boolean;
  readonly imageInput: boolean;
  readonly reasoning: boolean;
}

export interface ApiProviderPreset {
  readonly id: Extract<ApiProviderId,
    | "openai-codex"
    | "anthropic"
    | "glm"
    | "kimi"
    | "minimax"
    | "deepseek"
    | "qwen"
    | "qwen-token-plan"
    | "ollama"
    | "custom">;
  readonly name: string;
  readonly group: ApiProviderGroupId;
  readonly runtimeProviderId: string;
  readonly baseUrl: string;
  readonly docsUrl: string;
  readonly model: string;
  readonly models: readonly ApiProviderModelPreset[];
  readonly apiProtocol: ApiProviderProtocol;
  readonly authMode: ApiProviderAuthMode;
  readonly apiKeyRequired: boolean;
  readonly modelDiscovery: "supported" | "provider_dependent";
  /**
   * Default for mobile streaming. Mobile streams through the WebView fetch,
   * so it only works when the endpoint answers CORS for capacitor:// and
   * http://localhost. Users can override it per Provider.
   */
  readonly mobileStreaming?: boolean;
}

/**
 * Product presets supported by the pinned Pi 0.82.1 runtime.
 *
 * Base URLs are Pi model base URLs. Endpoint suffixes are appended only by
 * apiProviderRequestUrl(), so the UI and runtime can never double-append
 * /chat/completions or /v1/messages.
 */
export const API_PROVIDER_PRESETS: readonly ApiProviderPreset[] =
  Object.freeze([
    preset({
      id: "openai-codex",
      name: "OpenAI Codex Beta",
      group: "account",
      runtimeProviderId: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      docsUrl: "https://developers.openai.com/codex/",
      apiProtocol: "openai-codex-responses",
      authMode: "oauth",
      apiKeyRequired: false,
      modelDiscovery: "supported",
      models: [
        model(
          "gpt-5.3-codex-spark",
          128_000,
          128_000,
          true,
          false,
          true,
          "GPT-5.3 Codex Spark"
        ),
        model("gpt-5.4", 272_000, 128_000, true, true, true, "GPT-5.4"),
        model("gpt-5.4-mini", 272_000, 128_000, true, true, true, "GPT-5.4 mini"),
        model("gpt-5.5", 272_000, 128_000, true, true, true, "GPT-5.5"),
        model("gpt-5.6-luna", 272_000, 128_000, true, true, true, "GPT-5.6 Luna"),
        model("gpt-5.6-sol", 272_000, 128_000, true, true, true, "GPT-5.6 Sol"),
        model("gpt-5.6-terra", 272_000, 128_000, true, true, true, "GPT-5.6 Terra")
      ]
    }),
    preset({
      id: "anthropic",
      name: "Claude Code",
      group: "provider",
      runtimeProviderId: "anthropic",
      baseUrl: "https://api.anthropic.com",
      docsUrl: "https://docs.anthropic.com/en/api/getting-started",
      apiProtocol: "anthropic-messages",
      apiKeyRequired: true,
      modelDiscovery: "supported",
      models: [
        model("claude-fable-5", 1_000_000, 128_000, true, true, true, "Claude Fable 5"),
        model("claude-opus-5", 1_000_000, 128_000, true, true, true, "Claude Opus 5"),
        model("claude-sonnet-5", 1_000_000, 128_000, true, true, true, "Claude Sonnet 5"),
        model("claude-haiku-4-5", 200_000, 64_000, true, true, true, "Claude Haiku 4.5"),
        model("claude-haiku-4-5-20251001", 200_000, 64_000, true, true, true, "Claude Haiku 4.5 (2025-10-01)")
      ]
    }),
    preset({
      id: "glm",
      name: "智谱开放平台 / GLM API",
      group: "provider",
      runtimeProviderId: "zai-coding-cn",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "provider_dependent",
      models: [
        model("glm-4.7", 204_800, 131_072, true, false, true),
        model("glm-5-turbo", 200_000, 131_072, true, false, true),
        model("glm-5v-turbo", 200_000, 131_072, true, true, true)
      ]
    }),
    preset({
      id: "kimi",
      name: "Kimi 中国版 / Kimi China",
      group: "provider",
      runtimeProviderId: "moonshotai-cn",
      baseUrl: "https://api.moonshot.cn/v1",
      docsUrl: "https://platform.moonshot.cn/docs/guide/start-using-kimi-api",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "supported",
      mobileStreaming: true,
      models: [
        model("kimi-k2.5", KIMI_K2_CONTEXT_WINDOW, KIMI_MAX_OUTPUT_RESERVE, true, true, true, undefined, KIMI_K2_CONTEXT_WINDOW),
        model("kimi-k2-thinking", KIMI_K2_CONTEXT_WINDOW, KIMI_MAX_OUTPUT_RESERVE, true, false, true, undefined, KIMI_K2_CONTEXT_WINDOW),
        model("kimi-k2-turbo-preview", KIMI_K2_CONTEXT_WINDOW, KIMI_MAX_OUTPUT_RESERVE, true, false, false, undefined, KIMI_K2_CONTEXT_WINDOW)
      ]
    }),
    preset({
      id: "minimax",
      name: "MiniMax 中国版 / MiniMax China",
      group: "provider",
      runtimeProviderId: "minimax-cn",
      baseUrl: "https://api.minimaxi.com/anthropic",
      docsUrl: "https://platform.minimaxi.com/document/Guides",
      apiProtocol: "anthropic-messages",
      apiKeyRequired: true,
      modelDiscovery: "provider_dependent",
      models: [
        model("MiniMax-M2.7", 204_800, 131_072, true, false, true),
        model("MiniMax-M2.7-highspeed", 204_800, 131_072, true, false, true),
        model("MiniMax-M3", 1_000_000, 128_000, true, true, true)
      ]
    }),
    preset({
      id: "deepseek",
      name: "深度求索 / DeepSeek",
      group: "provider",
      runtimeProviderId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      docsUrl: "https://api-docs.deepseek.com/",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "supported",
      mobileStreaming: true,
      models: [
        model("deepseek-v4-flash", 1_000_000, 384_000, true, false, true, "DeepSeek-V4 Flash"),
        model("deepseek-flash", 1_048_576, 393_216, true, true, true, "DeepSeek-V4.1-Flash"),
        model("deepseek-v4-pro", 1_000_000, 384_000, true, false, true, "DeepSeek-V4 Pro")
      ]
    }),
    preset({
      id: "qwen",
      name: "通义千问 / Qwen API",
      group: "provider",
      runtimeProviderId: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      docsUrl: "https://help.aliyun.com/zh/model-studio/getting-started/first-api-call-to-qwen",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "supported",
      mobileStreaming: true,
      models: []
    }),
    preset({
      id: "qwen-token-plan",
      name: "通义千问 Token Plan / Qwen Token Plan",
      group: "token-plan",
      runtimeProviderId: "qwen-token-plan-cn",
      baseUrl: QWEN_TOKEN_PLAN_API_BASE_URL,
      docsUrl: "https://help.aliyun.com/zh/model-studio/token-plan",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "supported",
      models: []
    }),
    preset({
      id: "ollama",
      name: "Ollama 本地 / Ollama",
      group: "provider",
      runtimeProviderId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      docsUrl: "https://docs.ollama.com/api/openai-compatibility",
      apiProtocol: "openai-completions",
      apiKeyRequired: false,
      modelDiscovery: "supported",
      models: [
        model("qwen2.5:7b", 32_768, 8_192, true, false, false),
        model("llama3.2", 131_072, 8_192, true, false, false)
      ]
    }),
    preset({
      id: "custom",
      name: "自定义 / Custom",
      group: "other",
      runtimeProviderId: "echoink-custom",
      baseUrl: "",
      docsUrl: "",
      apiProtocol: "openai-completions",
      apiKeyRequired: true,
      modelDiscovery: "provider_dependent",
      models: []
    })
  ]);

export function getApiProviderPreset(
  providerId: ApiProviderId
): ApiProviderPreset {
  return API_PROVIDER_PRESETS.find((preset) => preset.id === providerId)
    ?? API_PROVIDER_PRESETS[API_PROVIDER_PRESETS.length - 1];
}

export function apiProviderPresetDisplayName(
  providerId: ApiProviderId,
  language: "zh-CN" | "en"
): string {
  const name = getApiProviderPreset(providerId).name;
  const divider = " / ";
  const dividerIndex = name.indexOf(divider);
  if (dividerIndex < 0) return name;
  const chinese = name.slice(0, dividerIndex).trim();
  const english = name.slice(dividerIndex + divider.length).trim();
  return language === "en"
    ? english || chinese || name
    : chinese || english || name;
}

export function apiProviderConfiguredDisplayName(
  providerId: ApiProviderId,
  configuredName: string,
  language: "zh-CN" | "en"
): string {
  const localized = apiProviderPresetDisplayName(providerId, language);
  return apiProviderConfiguredNameOverride(providerId, configuredName)
    || localized;
}

export function apiProviderConfiguredNameOverride(
  providerId: ApiProviderId,
  configuredName: string
): string {
  const preset = getApiProviderPreset(providerId);
  const configured = configuredName.trim();
  const presetNames = new Set([
    preset.name,
    apiProviderPresetDisplayName(providerId, "zh-CN"),
    apiProviderPresetDisplayName(providerId, "en")
  ]);
  if (providerId === "anthropic") {
    presetNames.add("Anthropic");
    presetNames.add("Anthropic / Anthropic");
  }
  return !configured || presetNames.has(configured) ? "" : configured;
}

export function getApiProviderModelPreset(
  providerId: ApiProviderId,
  modelId: string
): ApiProviderModelPreset | null {
  const preset = getApiProviderPreset(providerId);
  return preset.models.find((model) => model.id === modelId) ?? null;
}

export function apiProviderModelMaxTokens(
  providerId: ApiProviderId,
  modelId: string,
  fallback: number
): number {
  return getApiProviderModelPreset(providerId, modelId)?.modelMaxTokens
    ?? fallback;
}

export function apiProviderMaxOutputReserve(
  providerId: ApiProviderId,
  modelId: string,
  configuredLimit: number
): number {
  const preset = getApiProviderModelPreset(providerId, modelId);
  return providerId === "kimi"
    ? Math.min(
        configuredLimit,
        preset?.maxOutputTokens ?? KIMI_MAX_OUTPUT_RESERVE
      )
    : configuredLimit;
}

export function apiProviderApiKeyRequired(
  providerId: ApiProviderId
): boolean {
  return getApiProviderPreset(providerId).apiKeyRequired;
}

export function apiProviderAuthMode(
  providerId: ApiProviderId
): ApiProviderAuthMode {
  return getApiProviderPreset(providerId).authMode;
}

export function normalizeApiProviderId(
  value: unknown,
  baseUrl = "",
  name = ""
): ApiProviderId {
  if (
    value === "custom"
    && isQwenTokenPlanApiProviderUrl(baseUrl)
  ) {
    return "qwen-token-plan";
  }
  if (
    typeof value === "string"
    && (API_PROVIDER_IDS as readonly string[]).includes(value)
  ) {
    return value as ApiProviderId;
  }
  const normalizedBaseUrl = baseUrl.toLowerCase();
  const normalizedName = name.trim().toLowerCase();
  if (
    normalizedBaseUrl.includes("chatgpt.com/backend-api")
    || normalizedName === "openai codex"
    || normalizedName === "openai codex beta"
  ) return "openai-codex";
  if (
    normalizedBaseUrl.includes("127.0.0.1:11434")
    || normalizedBaseUrl.includes("localhost:11434")
    || normalizedName === "ollama"
  ) return "ollama";
  if (
    normalizedBaseUrl.includes("deepseek")
    || normalizedName === "deepseek"
  ) return "deepseek";
  if (
    normalizedBaseUrl.includes("bigmodel")
    || normalizedName === "glm"
  ) return "glm";
  if (
    normalizedBaseUrl.includes("moonshot")
    || normalizedName === "kimi"
  ) return "kimi";
  if (
    normalizedBaseUrl.includes("minimaxi")
    || normalizedName === "minimax"
  ) return "minimax";
  if (
    isQwenTokenPlanApiProviderUrl(baseUrl)
    || normalizedName === "qwen token plan"
    || normalizedName === "通义千问 token plan"
  ) return "qwen-token-plan";
  if (
    normalizedBaseUrl.includes("dashscope")
    || normalizedName === "qwen"
  ) return "qwen";
  if (
    normalizedBaseUrl.includes("anthropic")
    || normalizedName === "anthropic"
  ) return "anthropic";
  if (
    normalizedBaseUrl.includes("api.openai.com")
    || normalizedName === "openai"
  ) return "openai";
  return "custom";
}

export function normalizeApiProviderProtocol(
  value: unknown,
  providerId: ApiProviderId
): ApiProviderProtocol {
  if (providerId === "anthropic") return "anthropic-messages";
  if (providerId === "openai") {
    return value === "openai-responses"
      ? "openai-responses"
      : "openai-completions";
  }
  if (
    providerId === "custom"
    && typeof value === "string"
    && [
      "openai-completions",
      "openai-responses",
      "anthropic-messages"
    ].includes(value)
  ) {
    return value as ApiProviderProtocol;
  }
  return getApiProviderPreset(providerId).apiProtocol;
}

export function normalizeApiProviderBaseUrl(
  baseUrl: string,
  apiProtocol: ApiProviderProtocol
): string {
  const parsed = new URL(baseUrl.trim());
  const loopbackHttp = parsed.protocol === "http:"
    && isLoopbackHostname(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !loopbackHttp)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("provider_url_invalid");
  }
  let path = parsed.pathname.replace(/\/+$/u, "");
  if (apiProtocol === "openai-responses") {
    path = path.replace(/\/responses$/u, "");
  } else if (apiProtocol === "openai-codex-responses") {
    path = path.replace(/\/codex(?:\/responses)?$/u, "");
  } else if (apiProtocol === "openai-completions") {
    path = path.replace(/\/chat\/completions$/u, "");
  } else {
    path = path.replace(/\/v1(?:\/messages)?$/u, "");
  }
  parsed.pathname = path || "/";
  return parsed.toString().replace(/\/$/u, "");
}

export function isLoopbackApiProviderUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isQwenTokenPlanApiProviderUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "https:"
      && parsed.hostname === QWEN_TOKEN_PLAN_API_HOST
      && (parsed.port === "" || parsed.port === "443")
      && parsed.pathname.replace(/\/+$/u, "") === QWEN_TOKEN_PLAN_API_BASE_PATH
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

export function apiProviderRequestUrl(
  baseUrl: string,
  apiProtocol: ApiProviderProtocol
): string {
  const normalized = normalizeApiProviderBaseUrl(baseUrl, apiProtocol);
  if (apiProtocol === "openai-responses") {
    return `${normalized}/responses`;
  }
  if (apiProtocol === "openai-codex-responses") {
    return `${normalized}/codex/responses`;
  }
  if (apiProtocol === "anthropic-messages") {
    return `${normalized}/v1/messages`;
  }
  return `${normalized}/chat/completions`;
}

export function apiProviderModelsUrl(
  baseUrl: string,
  apiProtocol: ApiProviderProtocol
): string {
  const normalized = normalizeApiProviderBaseUrl(baseUrl, apiProtocol);
  return apiProtocol === "anthropic-messages"
    ? `${normalized}/v1/models`
    : `${normalized}/models`;
}

export function openAiCompatibleChatCompletionsUrl(
  baseUrl: string
): string {
  return apiProviderRequestUrl(baseUrl, "openai-completions");
}

function preset(
  input: Omit<ApiProviderPreset, "model" | "authMode">
  & Partial<Pick<ApiProviderPreset, "authMode">>
): ApiProviderPreset {
  return Object.freeze({
    ...input,
    authMode: input.authMode ?? "api-key",
    model: input.models[0]?.id ?? "",
    models: Object.freeze([...input.models])
  });
}

function model(
  id: string,
  contextWindow: number,
  maxOutputTokens: number,
  toolCalling: boolean,
  imageInput: boolean,
  reasoning: boolean,
  displayName?: string,
  modelMaxTokens = maxOutputTokens
): ApiProviderModelPreset {
  return Object.freeze({
    id,
    displayName,
    contextWindow,
    modelMaxTokens,
    maxOutputTokens,
    toolCalling,
    imageInput,
    reasoning
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}
