import type {
  Api,
  Model,
  ModelThinkingLevel,
  ThinkingLevelMap
} from "@earendil-works/pi-ai";

export interface EchoInkProviderReasoningWirePolicy {
  readonly id: "qwen-3.8-chat-completions";
  readonly selectableLevels: readonly ModelThinkingLevel[];
  readonly defaultLevel: ModelThinkingLevel;
  readonly thinkingLevelMap: Readonly<ThinkingLevelMap>;
}

const QWEN_38_CHAT_COMPLETIONS_POLICY: EchoInkProviderReasoningWirePolicy =
  Object.freeze({
    id: "qwen-3.8-chat-completions",
    selectableLevels: Object.freeze([
      "low",
      "medium",
      "xhigh"
    ] as const),
    defaultLevel: "xhigh",
    thinkingLevelMap: Object.freeze({
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "xhigh",
      xhigh: "xhigh",
      max: "xhigh"
    })
  });

const QWEN_38_CHAT_COMPLETIONS_MODELS = Object.freeze(
  new Set([
    "qwen/qwen3.8-max",
    "qwen-token-plan/qwen3.8-max",
    "qwen-token-plan/qwen3.8-max-preview",
    "qwen-token-plan-cn/qwen3.8-max",
    "qwen-token-plan-cn/qwen3.8-max-preview"
  ])
);

export function resolveEchoInkProviderReasoningWirePolicy(
  runtimeProviderId: string,
  modelId: string
): Readonly<EchoInkProviderReasoningWirePolicy> | null {
  const identity = `${runtimeProviderId.trim()}/${modelId.trim()}`;
  return QWEN_38_CHAT_COMPLETIONS_MODELS.has(identity)
    ? QWEN_38_CHAT_COMPLETIONS_POLICY
    : null;
}

export function withEchoInkProviderReasoningWirePolicy<TApi extends Api>(
  model: Model<TApi>
): Model<TApi> {
  if (model.provider === "deepseek" && model.api === "openai-completions") {
    return {
      ...structuredClone(model),
      compat: {
        ...(model as Model<"openai-completions">).compat,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
        supportsReasoningEffort: true
      }
    } as Model<TApi>;
  }
  const policy = resolveEchoInkProviderReasoningWirePolicy(
    model.provider,
    model.id
  );
  if (!policy || !model.reasoning || model.api !== "openai-completions") {
    return model;
  }
  const completionsModel = model as Model<"openai-completions">;
  return {
    ...structuredClone(model),
    thinkingLevelMap: {
      ...model.thinkingLevelMap,
      ...policy.thinkingLevelMap
    },
    compat: {
      ...completionsModel.compat,
      thinkingFormat: "qwen",
      supportsReasoningEffort: true
    }
  } as Model<TApi>;
}

export function applyEchoInkProviderReasoningWirePolicy(
  payload: unknown,
  model: Readonly<Model<Api>>,
  level: ModelThinkingLevel | undefined
): unknown {
  const policy = resolveEchoInkProviderReasoningWirePolicy(
    model.provider,
    model.id
  );
  if (!policy || model.api !== "openai-completions" || !isPlainRecord(payload)) {
    return payload;
  }
  const next: Record<string, unknown> = { ...payload };
  delete next.thinking_budget;
  const enabled = Boolean(level && level !== "off");
  next.enable_thinking = enabled;
  if (!enabled) {
    delete next.reasoning_effort;
    return next;
  }
  const mapped = policy.thinkingLevelMap[level!];
  if (typeof mapped !== "string") {
    throw new Error("provider_reasoning_level_invalid");
  }
  next.reasoning_effort = mapped;
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}
