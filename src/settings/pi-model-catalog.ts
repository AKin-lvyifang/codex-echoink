import type { DiscoveredProviderModel } from "./provider-model-discovery";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type ChatTemplateKwargValue,
  type Model,
  type ModelThinkingLevel
} from "@earendil-works/pi-ai";
import {
  ANTHROPIC_MODELS
} from "@earendil-works/pi-ai/providers/anthropic.models";
import {
  DEEPSEEK_MODELS
} from "@earendil-works/pi-ai/providers/deepseek.models";
import {
  MINIMAX_CN_MODELS
} from "@earendil-works/pi-ai/providers/minimax-cn.models";
import {
  MOONSHOTAI_CN_MODELS
} from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import {
  OPENAI_MODELS
} from "@earendil-works/pi-ai/providers/openai.models";
import {
  OPENAI_CODEX_MODELS
} from "@earendil-works/pi-ai/providers/openai-codex.models";
import {
  QWEN_TOKEN_PLAN_MODELS
} from "@earendil-works/pi-ai/providers/qwen-token-plan.models";
import {
  QWEN_TOKEN_PLAN_CN_MODELS
} from "@earendil-works/pi-ai/providers/qwen-token-plan-cn.models";
import {
  ZAI_CODING_CN_MODELS
} from "@earendil-works/pi-ai/providers/zai-coding-cn.models";
import {
  applyEchoInkProviderReasoningWirePolicy,
  resolveEchoInkProviderReasoningWirePolicy,
  withEchoInkProviderReasoningWirePolicy
} from "../harness/pi/provider-reasoning-wire-policy";
import type { ReasoningEffort } from "../types/app-server";

const ECHOINK_PI_MODEL_CATALOGS = Object.freeze({
  "openai-codex": OPENAI_CODEX_MODELS,
  "zai-coding-cn": ZAI_CODING_CN_MODELS,
  "moonshotai-cn": MOONSHOTAI_CN_MODELS,
  "minimax-cn": MINIMAX_CN_MODELS,
  deepseek: DEEPSEEK_MODELS,
  "qwen-token-plan": QWEN_TOKEN_PLAN_MODELS,
  "qwen-token-plan-cn": QWEN_TOKEN_PLAN_CN_MODELS,
  // Legacy OpenAI remains readable; Anthropic is also a current product preset.
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS
});

type EchoInkPiCatalogRuntimeProviderId =
  keyof typeof ECHOINK_PI_MODEL_CATALOGS;

const ECHOINK_PI_REASONING_LEVELS: readonly Readonly<{
  piLevel: ModelThinkingLevel;
  effort: ReasoningEffort;
}>[] = Object.freeze([
  Object.freeze({ piLevel: "off", effort: "none" }),
  Object.freeze({ piLevel: "minimal", effort: "minimal" }),
  Object.freeze({ piLevel: "low", effort: "low" }),
  Object.freeze({ piLevel: "medium", effort: "medium" }),
  Object.freeze({ piLevel: "high", effort: "high" }),
  Object.freeze({ piLevel: "xhigh", effort: "xhigh" }),
  Object.freeze({ piLevel: "max", effort: "max" })
]);

export interface EchoInkPiReasoningOption {
  readonly effort: ReasoningEffort;
  readonly piLevel: ModelThinkingLevel;
  readonly display: "off" | "level" | "toggle";
  /** Stable key for de-duplicating options that produce the same request. */
  readonly wireValueKey: string;
}

export interface EchoInkPiReasoningCapabilities {
  readonly source: "catalog" | "manual" | "unknown" | "discovery";
  /** Whether Pi exposes at least one real enabled reasoning state. */
  readonly supported: boolean;
  /** Whether Pi exposes a real off request for this model. */
  readonly supportsOff: boolean;
  /** Raw, wire-distinct Pi states, including off when it is real. */
  readonly options: readonly Readonly<EchoInkPiReasoningOption>[];
  /** Positive Composer choices normalized to the five product bands. */
  readonly enabledOptions: readonly Readonly<EchoInkPiReasoningOption>[];
  readonly defaultEffort: ReasoningEffort | null;
}

export function resolveEchoInkPiCatalogModel(
  runtimeProviderId: string,
  modelId: string
): Model<Api> | null {
  const providerId = runtimeProviderId.trim();
  const id = modelId.trim();
  if (!isEchoInkPiCatalogRuntimeProviderId(providerId) || !id) return null;
  const catalog = ECHOINK_PI_MODEL_CATALOGS[providerId] as Readonly<
    Record<string, Model<Api>>
  >;
  const model = Object.hasOwn(catalog, id) ? catalog[id] ?? null : null;
  return model ? withEchoInkResolvedPiReasoningModel(model) : null;
}

export function resolveEchoInkPiReasoningCapabilities(
  runtimeProviderId: string,
  modelId: string,
  configured: boolean | { reasoning: boolean; discovery?: DiscoveredProviderModel; metadataSource?: string } = false
): Readonly<EchoInkPiReasoningCapabilities> {
  const manuallyConfiguredReasoning = typeof configured === "boolean" ? configured : configured.reasoning;
  if (typeof configured !== "boolean" && configured.discovery) {
    const declared = declaredReasoningCapabilities(configured.reasoning, configured.discovery);
    if (declared) return declared;
    // An effective false (including a user override) must not be replaced by catalog true.
    if (!configured.reasoning) return frozenCapabilities("discovery", [], null);
  }
  const model = resolveEchoInkPiCatalogModel(runtimeProviderId, modelId);
  if (model) {
    return resolveEchoInkPiModelReasoningCapabilities(typeof configured !== "boolean" && configured.discovery
      ? { ...model, reasoning: configured.reasoning }
      : model);
  }
  if (!manuallyConfiguredReasoning) {
    return frozenCapabilities("unknown", [], null);
  }
  const providerPolicy = resolveEchoInkProviderReasoningWirePolicy(
    runtimeProviderId,
    modelId
  );
  if (providerPolicy) {
    return frozenCapabilities("manual", [
      {
        effort: "none",
        piLevel: "off",
        display: "off",
        wireValueKey: `${providerPolicy.id}:off`
      },
      ...providerPolicy.selectableLevels.map((level) => ({
        effort: level as ReasoningEffort,
        piLevel: level,
        display: "level" as const,
        wireValueKey: `${providerPolicy.id}:${
          providerPolicy.thinkingLevelMap[level] ?? level
        }`
      }))
    ], providerPolicy.defaultLevel as ReasoningEffort);
  }
  return frozenCapabilities("manual", [
    {
      effort: "none",
      piLevel: "off",
      display: "off",
      wireValueKey: "manual:off"
    },
    {
      effort: "low",
      piLevel: "low",
      display: "level",
      wireValueKey: "manual:low"
    },
    {
      effort: "medium",
      piLevel: "medium",
      display: "level",
      wireValueKey: "manual:medium"
    },
    {
      effort: "high",
      piLevel: "high",
      display: "level",
      wireValueKey: "manual:high"
    },
    {
      effort: "xhigh",
      piLevel: "xhigh",
      display: "level",
      wireValueKey: "manual:xhigh"
    },
    {
      effort: "max",
      piLevel: "max",
      display: "level",
      wireValueKey: "manual:max"
    }
  ], "medium");
}

export function resolveEchoInkPiModelReasoningCapabilities(
  model: Model<Api>
): Readonly<EchoInkPiReasoningCapabilities> {
  const metadata = (model as Model<Api> & { echoInkReasoningMetadata?: DiscoveredProviderModel }).echoInkReasoningMetadata;
  if (metadata) {
    const declared = declaredReasoningCapabilities(model.reasoning, metadata);
    if (declared) return declared;
  }
  if (!model.reasoning) {
    return frozenCapabilities("catalog", [], null);
  }
  const supported = new Set(getSupportedThinkingLevels(model));
  const groups = new Map<string, Readonly<EchoInkPiReasoningOption>>();
  for (const candidate of ECHOINK_PI_REASONING_LEVELS) {
    if (!supported.has(candidate.piLevel)) continue;
    const option = Object.freeze({
      ...candidate,
      display: reasoningOptionDisplay(model, candidate.piLevel),
      wireValueKey: reasoningWireValueKey(model, candidate.piLevel)
    });
    const current = groups.get(option.wireValueKey);
    if (!current || reasoningOptionPreference(model, option.piLevel)
      > reasoningOptionPreference(model, current.piLevel)) {
      groups.set(option.wireValueKey, option);
    }
  }
  const options = [...groups.values()];
  const enabledOptions = canonicalEnabledReasoningOptions(options);
  const providerPolicy = resolveEchoInkProviderReasoningWirePolicy(
    model.provider,
    model.id
  );
  if (enabledOptions.length === 1 && !providerPolicy) {
    return frozenCapabilities(
      "catalog",
      experimentalFiveLevelOptions(options),
      "medium"
    );
  }
  const clampedDefault = clampThinkingLevel(
    model,
    providerPolicy?.defaultLevel ?? "medium"
  );
  const defaultWireValueKey = reasoningWireValueKey(model, clampedDefault);
  const rawDefault = options.find(
    (option) => option.wireValueKey === defaultWireValueKey
  ) ?? null;
  const defaultEffort = rawDefault && rawDefault.effort !== "none"
    ? enabledOptions.find(
        (option) => option.wireValueKey === rawDefault.wireValueKey
      )?.effort
      ?? enabledOptions.find(
        (option) => reasoningPresentationBand(option.effort)
          === reasoningPresentationBand(rawDefault.effort)
      )?.effort
      ?? null
    : enabledOptions.find((option) => option.effort === "medium")?.effort
      ?? enabledOptions[0]?.effort
      ?? null;
  return frozenCapabilities("catalog", options, defaultEffort);
}

export function withDiscoveredPiReasoningModel(model: Model<Api>, discovery?: DiscoveredProviderModel): Model<Api> {
  if (!discovery) return model;
  const levels = discovery.reasoningLevels;
  const mapped = levels ? Object.fromEntries(ECHOINK_PI_REASONING_LEVELS
    .filter((entry) => entry.piLevel !== "off")
    .map((entry) => [entry.piLevel, levels.includes(entry.effort as Exclude<ReasoningEffort, "none">) ? entry.piLevel : null])) : model.thinkingLevelMap;
  return {
    ...structuredClone(model),
    ...(mapped ? { thinkingLevelMap: mapped } : {}),
    echoInkReasoningMetadata: structuredClone(discovery)
  } as Model<Api>;
}

function declaredReasoningCapabilities(reasoning: boolean, discovery: DiscoveredProviderModel): Readonly<EchoInkPiReasoningCapabilities> | null {
  if (!reasoning) return frozenCapabilities("discovery", [], null);
  if (!discovery.reasoningLevels?.length) return null;
  const levels = discovery.reasoningLevels;
  const defaultEffort = discovery.defaultReasoningEffort ?? levels[0];
  const options: EchoInkPiReasoningOption[] = [
    { effort: "none", piLevel: "off", display: "off", wireValueKey: "discovery:off" },
    ...levels.map((level) => ({ effort: level, piLevel: level, display: "level" as const, wireValueKey: `discovery:${level}` }))
  ];
  return frozenCapabilities("discovery", options, defaultEffort);
}

export function withEchoInkResolvedPiReasoningModel<TApi extends Api>(
  model: Model<TApi>
): Model<TApi> {
  const providerResolved = withEchoInkProviderReasoningWirePolicy(model);
  const capabilities = resolveEchoInkPiModelReasoningCapabilities(
    providerResolved
  );
  if (!echoInkPiReasoningUsesExperimentalFiveLevels(capabilities)) {
    return providerResolved;
  }
  return {
    ...structuredClone(providerResolved),
    thinkingLevelMap: {
      ...providerResolved.thinkingLevelMap,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max"
    }
  };
}

export function applyEchoInkPiReasoningPayload(
  payload: unknown,
  model: Readonly<Model<Api>>,
  level: ModelThinkingLevel | undefined
): unknown {
  if (resolveEchoInkProviderReasoningWirePolicy(model.provider, model.id)) {
    return applyEchoInkProviderReasoningWirePolicy(payload, model, level);
  }
  const capabilities = resolveEchoInkPiModelReasoningCapabilities(model);
  if (
    !echoInkPiReasoningUsesExperimentalFiveLevels(capabilities)
    || !isPlainRecord(payload)
  ) return payload;
  const next: Record<string, unknown> = { ...payload };
  if (!level || level === "off") {
    delete next.reasoning_effort;
  } else {
    next.reasoning_effort = level;
  }
  return next;
}

export function echoInkPiReasoningUsesExperimentalFiveLevels(
  capabilities: Readonly<EchoInkPiReasoningCapabilities>
): boolean {
  return capabilities.enabledOptions.length === 5
    && capabilities.enabledOptions.every(
      (option) => option.wireValueKey.startsWith("experimental:")
    );
}

export function echoInkReasoningEffortToPiLevel(
  effort: ReasoningEffort
): ModelThinkingLevel {
  return effort === "none" ? "off" : effort;
}

export function isEchoInkReasoningEffort(value: unknown): value is ReasoningEffort {
  return ECHOINK_PI_REASONING_LEVELS.some((entry) => entry.effort === value);
}

export function normalizeEchoInkReasoningEffort(
  value: unknown
): ReasoningEffort | undefined {
  return isEchoInkReasoningEffort(value) ? value : undefined;
}

export function echoInkPiReasoningOption(
  capabilities: Readonly<EchoInkPiReasoningCapabilities>,
  effort: ReasoningEffort
): Readonly<EchoInkPiReasoningOption> | null {
  return capabilities.options.find((option) => option.effort === effort) ?? null;
}

export function isEchoInkPiReasoningEffortSupported(
  capabilities: Readonly<EchoInkPiReasoningCapabilities>,
  effort: ReasoningEffort
): boolean {
  if (echoInkPiReasoningOption(capabilities, effort)) return true;
  // Models without reasoning still have one legal Pi state: off. A reasoning
  // model may only use off when Pi exposes a real off request for it.
  return effort === "none"
    && (!capabilities.supported || capabilities.supportsOff);
}

function frozenCapabilities(
  source: EchoInkPiReasoningCapabilities["source"],
  options: readonly EchoInkPiReasoningOption[],
  defaultEffort: ReasoningEffort | null
): Readonly<EchoInkPiReasoningCapabilities> {
  const frozenOptions = Object.freeze(
    options.map((option) => Object.freeze({ ...option }))
  );
  const enabledOptions = Object.freeze(
    canonicalEnabledReasoningOptions(frozenOptions)
  );
  const supported = enabledOptions.length > 0;
  return Object.freeze({
    source,
    supported,
    supportsOff: supported
      && frozenOptions.some((option) => option.effort === "none"),
    options: frozenOptions,
    enabledOptions,
    defaultEffort: supported ? defaultEffort : null
  });
}

function canonicalEnabledReasoningOptions(
  options: readonly Readonly<EchoInkPiReasoningOption>[]
): Readonly<EchoInkPiReasoningOption>[] {
  const bands = new Map<string, Readonly<EchoInkPiReasoningOption>>();
  for (const option of options) {
    if (option.effort === "none") continue;
    const band = reasoningPresentationBand(option.effort);
    const current = bands.get(band);
    if (!current || reasoningBandOptionPreference(option)
      > reasoningBandOptionPreference(current)) {
      bands.set(band, option);
    }
  }
  return [...bands.values()];
}

function experimentalFiveLevelOptions(
  rawOptions: readonly Readonly<EchoInkPiReasoningOption>[]
): EchoInkPiReasoningOption[] {
  const off = rawOptions.find((option) => option.effort === "none");
  const enabled = ([
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ] as const).map((level) => ({
    effort: level,
    piLevel: level,
    display: "level" as const,
    wireValueKey: `experimental:${level}`
  }));
  return off ? [{ ...off }, ...enabled] : enabled;
}

function reasoningPresentationBand(effort: ReasoningEffort): string {
  if (effort === "minimal" || effort === "low") return "low";
  return effort;
}

function reasoningBandOptionPreference(
  option: Readonly<EchoInkPiReasoningOption>
): number {
  // Both minimal and low are presented as the low product band. Prefer low
  // when Pi exposes both; retain minimal when it is the only real low state.
  if (option.effort === "low") return 2;
  if (option.effort === "minimal") return 1;
  return 0;
}

function reasoningOptionPreference(
  model: Model<Api>,
  level: ModelThinkingLevel
): number {
  if (level === "off") return 100;
  const representative = reasoningWireEffort(model, level);
  if (representative === level) return 100;
  if (level === "medium") return 90;
  if (level === "low") return 70;
  return 60;
}

function reasoningOptionDisplay(
  model: Model<Api>,
  level: ModelThinkingLevel
): EchoInkPiReasoningOption["display"] {
  if (level === "off") return "off";
  if (resolveEchoInkProviderReasoningWirePolicy(model.provider, model.id)) {
    return "level";
  }
  if (model.api !== "openai-completions") return "level";
  const completionsModel = model as Model<"openai-completions">;
  const format = resolvedOpenAICompletionsThinkingFormat(completionsModel);
  if (format === "qwen" || format === "qwen-chat-template") return "toggle";
  if (
    (format === "zai" || format === "together" || format === "deepseek")
    && !openAICompletionsSupportsReasoningEffort(completionsModel, format)
  ) return "toggle";
  return "level";
}

function reasoningWireValueKey(
  model: Model<Api>,
  level: ModelThinkingLevel
): string {
  if (
    isAnthropicAdaptiveThinkingModel(model)
  ) {
    return `${model.api}:${level === "off"
      ? "off"
      : anthropicAdaptiveThinkingEffort(model, level)}`;
  }
  if (model.api !== "openai-completions") {
    return `${model.api}:${mappedThinkingValue(model, level)}`;
  }
  const completionsModel = model as Model<"openai-completions">;
  const format = resolvedOpenAICompletionsThinkingFormat(completionsModel);
  const enabled = level !== "off";
  const supportsEffort = openAICompletionsSupportsReasoningEffort(
    completionsModel,
    format
  );
  const mapped = mappedThinkingValue(model, level);
  switch (format) {
    case "qwen":
    case "qwen-chat-template": {
      if (resolveEchoInkProviderReasoningWirePolicy(model.provider, model.id)) {
        return `${format}:${enabled ? `on:${mapped}` : "off"}`;
      }
      return `${format}:${enabled}`;
    }
    case "zai":
    case "together":
    case "deepseek":
      return enabled && supportsEffort
        ? `${format}:on:${mapped}`
        : `${format}:${enabled ? "on" : "off"}`;
    case "ant-ling": {
      const explicit = model.thinkingLevelMap?.[level];
      return enabled && typeof explicit === "string"
        ? `${format}:${explicit}`
        : `${format}:absent`;
    }
    case "chat-template":
      return `${format}:${chatTemplateWireValueKey(
        completionsModel,
        level
      )}`;
    default:
      return `${format}:${mapped}`;
  }
}

function reasoningWireEffort(
  model: Model<Api>,
  level: ModelThinkingLevel
): string | null {
  if (
    isAnthropicAdaptiveThinkingModel(model)
  ) {
    return anthropicAdaptiveThinkingEffort(model, level);
  }
  if (model.api === "openai-completions") {
    const completionsModel = model as Model<"openai-completions">;
    const format = resolvedOpenAICompletionsThinkingFormat(completionsModel);
    if (format === "qwen" || format === "qwen-chat-template") {
      return resolveEchoInkProviderReasoningWirePolicy(
        model.provider,
        model.id
      )
        ? mappedThinkingValue(model, level)
        : null;
    }
    if (
      (format === "zai" || format === "together" || format === "deepseek")
      && !openAICompletionsSupportsReasoningEffort(completionsModel, format)
    ) return null;
  }
  return mappedThinkingValue(model, level);
}

function anthropicAdaptiveThinkingEffort(
  model: Model<Api>,
  level: ModelThinkingLevel
): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high") return level;
  return "high";
}

function isAnthropicAdaptiveThinkingModel(model: Model<Api>): boolean {
  return model.api === "anthropic-messages"
    && (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking
      === true;
}

function mappedThinkingValue(
  model: Model<Api>,
  level: ModelThinkingLevel
): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  return level === "off" ? "none" : level;
}

type OpenAICompletionsThinkingFormat = NonNullable<
  NonNullable<Model<"openai-completions">["compat"]>["thinkingFormat"]
>;

function resolvedOpenAICompletionsThinkingFormat(
  model: Model<"openai-completions">
): OpenAICompletionsThinkingFormat {
  const explicit = model.compat?.thinkingFormat;
  if (explicit) return explicit;
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  if (provider === "deepseek" || baseUrl.includes("deepseek.com")) {
    return "deepseek";
  }
  if (
    provider === "zai"
    || provider === "zai-coding-cn"
    || baseUrl.includes("api.z.ai")
    || baseUrl.includes("open.bigmodel.cn")
  ) return "zai";
  if (
    provider === "together"
    || baseUrl.includes("api.together.ai")
    || baseUrl.includes("api.together.xyz")
  ) return "together";
  if (provider === "ant-ling" || baseUrl.includes("api.ant-ling.com")) {
    return "ant-ling";
  }
  if (provider === "openrouter" || baseUrl.includes("openrouter.ai")) {
    return "openrouter";
  }
  return "openai";
}

function openAICompletionsSupportsReasoningEffort(
  model: Model<"openai-completions">,
  format: OpenAICompletionsThinkingFormat
): boolean {
  if (typeof model.compat?.supportsReasoningEffort === "boolean") {
    return model.compat.supportsReasoningEffort;
  }
  if (format === "zai" || format === "together" || format === "ant-ling") {
    return false;
  }
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  return provider !== "xai"
    && provider !== "moonshotai"
    && provider !== "moonshotai-cn"
    && provider !== "nvidia"
    && provider !== "cloudflare-ai-gateway"
    && !baseUrl.includes("api.x.ai")
    && !baseUrl.includes("api.moonshot.")
    && !baseUrl.includes("integrate.api.nvidia.com")
    && !baseUrl.includes("gateway.ai.cloudflare.com");
}

function chatTemplateWireValueKey(
  model: Model<"openai-completions">,
  level: ModelThinkingLevel
): string {
  const entries = Object.entries(model.compat?.chatTemplateKwargs ?? {})
    .flatMap(([key, value]) => {
      const resolved = resolveChatTemplateValue(model, level, value);
      return resolved === undefined ? [] : [[key, resolved] as const];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function resolveChatTemplateValue(
  model: Model<"openai-completions">,
  level: ModelThinkingLevel,
  value: ChatTemplateKwargValue
): string | number | boolean | null | undefined {
  if (typeof value !== "object" || value === null) return value;
  if (level === "off" && value.omitWhenOff) return undefined;
  if (value.$var === "thinking.enabled") return level !== "off";
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return undefined;
  if (typeof mapped === "string") return mapped;
  return level === "off" ? undefined : level;
}

function isEchoInkPiCatalogRuntimeProviderId(
  value: string
): value is EchoInkPiCatalogRuntimeProviderId {
  return Object.hasOwn(ECHOINK_PI_MODEL_CATALOGS, value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}
