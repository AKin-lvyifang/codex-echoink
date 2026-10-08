import type { DiscoveredProviderModel } from "../../settings/provider-model-discovery";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai";
import type {
  ControlledPiStreamPort,
  PiProviderRuntimeConfig,
  PiProviderRuntimeConfigPort
} from "../pi/production-pi-model-resolver";
import type { ApiProviderProtocol } from "../../settings/provider-presets";
import {
  withDiscoveredPiReasoningModel,
  withEchoInkResolvedPiReasoningModel
} from "../../settings/pi-model-catalog";

const MAX_CONTROLLED_OUTPUT_TOKENS = 1_000_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export interface PiNativeProviderExecutionContext {
  runId: string;
  conversationId: string;
  turnId: string;
  correlationId: string;
}

export type PiNativeModelMetadataErrorCode =
  | "model_metadata_missing"
  | "model_metadata_incompatible";

export class PiNativeModelMetadataError extends Error {
  constructor(
    readonly code: PiNativeModelMetadataErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PiNativeModelMetadataError";
  }
}

export interface PiNativeControlledProviderOptions {
  config: PiProviderRuntimeConfigPort;
  controlledStream: ControlledPiStreamPort;
  model: Model<Api>;
  currentExecutionContext(): Readonly<PiNativeProviderExecutionContext>;
  /** Read-only observation of the exact Context sent to the controlled transport. */
  observeRequest?(input: Readonly<{
    execution: Readonly<PiNativeProviderExecutionContext>;
    model: Readonly<Model<Api>>;
    context: Readonly<Context>;
  }>): void;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  supportsToolCalling?: boolean;
}

/**
 * Clone a package-catalog model for EchoInk's configured endpoint without
 * inventing context metadata. Missing/invalid window data is a product-visible
 * incompatibility, never a 64K fallback.
 */
export function createPiNativeModelFromCatalog(input: {
  catalogModel: Model<Api> | undefined;
  provider: PiProviderRuntimeConfig;
}): Model<Api> {
  const source = input.catalogModel;
  if (!source) {
    throw new PiNativeModelMetadataError(
      "model_metadata_missing",
      `Pi model metadata is unavailable for ${input.provider.providerId}/${input.provider.modelRef}`
    );
  }
  if (
    source.id !== input.provider.modelRef
    || source.provider !== input.provider.providerId
    || source.api !== input.provider.apiProtocol
    || !positiveSafeInteger(source.contextWindow)
    || !positiveSafeInteger(source.maxTokens)
  ) {
    throw new PiNativeModelMetadataError(
      "model_metadata_incompatible",
      `Pi model metadata is incompatible for ${input.provider.providerId}/${input.provider.modelRef}`
    );
  }
  return deepFreeze({
    ...structuredClone(source),
    baseUrl: input.provider.baseUrl
  });
}

export function createPiNativeModelFromConfiguration(input: {
  catalogModel: Model<Api> | undefined;
  provider: PiProviderRuntimeConfig;
  configured: {
    apiProtocol: ApiProviderProtocol;
    contextWindow: number;
    maxOutputTokens: number;
    reasoning: boolean;
    imageInput: boolean;
    discovery?: DiscoveredProviderModel;
  };
}): Model<Api> {
  const configuredModel = createConfiguredPiNativeModel(input);
  const catalogModel = input.catalogModel ? createPiNativeModelFromCatalog({ catalogModel: input.catalogModel, provider: input.provider }) : undefined;
  const model: Model<Api> = {
    ...structuredClone(catalogModel ?? configuredModel),
    name: input.configured.discovery?.displayName ?? catalogModel?.name ?? configuredModel.name,
    contextWindow: input.configured.contextWindow,
    maxTokens: input.configured.maxOutputTokens,
    reasoning: input.configured.discovery ? input.configured.reasoning : catalogModel?.reasoning ?? input.configured.reasoning,
    input: input.configured.discovery
      ? input.configured.imageInput ? ["text", "image"] : ["text"]
      : withResolvedPiModelImageCapability(catalogModel ?? configuredModel, input.configured.imageInput).input
  };
  return withEchoInkResolvedPiReasoningModel(withDiscoveredPiReasoningModel(model, input.configured.discovery));
}

function createConfiguredPiNativeModel(input: {
  provider: PiProviderRuntimeConfig;
  configured: {
    apiProtocol: ApiProviderProtocol;
    contextWindow: number;
    maxOutputTokens: number;
    reasoning: boolean;
    imageInput: boolean;
    discovery?: DiscoveredProviderModel;
  };
}): Model<Api> {
  const configured = input.configured;
  if (
    input.provider.apiProtocol !== configured.apiProtocol
    || !positiveSafeInteger(configured.contextWindow)
    || !positiveSafeInteger(configured.maxOutputTokens)
    || configured.maxOutputTokens > configured.contextWindow
  ) {
    throw new PiNativeModelMetadataError(
      "model_metadata_incompatible",
      `Configured Pi model metadata is incompatible for ${input.provider.providerId}/${input.provider.modelRef}`
    );
  }
  const model: Model<Api> = {
    id: input.provider.modelRef,
    name: input.provider.modelRef,
    api: configured.apiProtocol,
    provider: input.provider.providerId,
    baseUrl: input.provider.baseUrl,
    reasoning: configured.reasoning,
    input: configured.imageInput ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: configured.contextWindow,
    maxTokens: configured.maxOutputTokens,
    ...(configured.reasoning
      ? {
          thinkingLevelMap: {
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max"
          }
        }
      : {})
  };
  if (configured.apiProtocol === "openai-completions") {
    model.compat = {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      supportsReasoningEffort: configured.reasoning,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: false
    };
  }
  return withResolvedPiModelImageCapability(
    model,
    configured.imageInput
  );
}

/**
 * The selected Pi Model is the single image-capability truth. Package catalog
 * metadata uses `input`, while user-configured models expose `imageInput` before
 * resolution; either affirmative signal enables image input.
 */
export function piModelSupportsImageInput(
  model: Readonly<{
    imageInput?: unknown;
    input?: unknown;
  }> | null | undefined
): boolean {
  return Boolean(
    model
    && (
      model.imageInput === true
      || (Array.isArray(model.input) && model.input.includes("image"))
    )
  );
}

function withResolvedPiModelImageCapability(
  model: Model<Api>,
  configuredImageInput: boolean
): Model<Api> {
  const supportsImageInput = configuredImageInput
    || piModelSupportsImageInput(model);
  if (!supportsImageInput || model.input.includes("image")) return model;
  return deepFreeze({
    ...structuredClone(model),
    input: [...model.input, "image"]
  });
}

/**
 * Native pi-ai Provider whose network implementation remains EchoInk's
 * controlled transport. Auth intentionally resolves no secret into
 * ModelRuntime; the transport reads the active Provider API key directly from
 * plugin settings for each request.
 */
export function createPiNativeControlledProvider(
  options: PiNativeControlledProviderOptions
): Provider {
  validateOptions(options);
  const model = deepFreeze(structuredClone(options.model));
  const provider: Provider = {
    id: model.provider,
    name: `EchoInk ${model.provider}`,
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: "EchoInk Provider API key",
        check: async () => ({
          type: "api_key",
          source: "EchoInk plugin settings"
        }),
        resolve: async () => ({
          auth: {},
          source: "EchoInk plugin settings"
        })
      }
    },
    getModels: () => [model],
    stream: (requestedModel, context, streamOptions) =>
      controlledProviderStream(
        options,
        model,
        requestedModel,
        context,
        streamOptions
      ),
    streamSimple: (requestedModel, context, streamOptions) =>
      controlledProviderStream(
        options,
        model,
        requestedModel,
        context,
        streamOptions
      )
  };
  return Object.freeze(provider);
}

function controlledProviderStream(
  options: PiNativeControlledProviderOptions,
  registeredModel: Model<Api>,
  requestedModel: Model<Api>,
  context: Context,
  streamOptions: SimpleStreamOptions | undefined
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      if (
        requestedModel.provider !== registeredModel.provider
        || requestedModel.id !== registeredModel.id
        || requestedModel.api !== registeredModel.api
        || hasAmbientCredential(streamOptions)
      ) {
        throw new Error("controlled_transport_required");
      }
      const configured = await options.config.read();
      if (
        !configured
        || configured.providerId !== registeredModel.provider
        || configured.modelRef !== registeredModel.id
        || configured.apiProtocol !== registeredModel.api
        || (
          configured.authMode === "oauth"
          && registeredModel.provider !== "openai-codex"
        )
      ) {
        throw new Error("provider_configuration_changed");
      }
      const execution = captureExecutionContext(
        options.currentExecutionContext()
      );
      const providerContext = cloneProviderContext(
        context,
        options.supportsToolCalling !== false
      );
      options.observeRequest?.({
        execution,
        model: registeredModel,
        context: providerContext
      });
      const upstream = await options.controlledStream.stream({
        ...execution,
        provider: structuredClone(configured),
        model: structuredClone(registeredModel),
        context: providerContext,
        options: {
          signal: streamOptions?.signal,
          ...(streamOptions?.reasoning
            ? { reasoning: streamOptions.reasoning }
            : {}),
          ...requestMaxTokens(
            streamOptions?.maxTokens,
            options.maxTokens,
            registeredModel.maxTokens,
            registeredModel.api === "anthropic-messages"
          ),
          temperature: boundedNumber(
            streamOptions?.temperature ?? options.temperature,
            0,
            2,
            0
          ),
          cacheRetention: "none",
          maxRetries: 0,
          timeoutMs: boundedInteger(
            options.timeoutMs,
            1_000,
            120_000,
            DEFAULT_PROVIDER_TIMEOUT_MS
          )
        }
      });
      for await (const event of upstream) output.push(event);
    } catch (error) {
      output.push({
        type: "error",
        reason: streamOptions?.signal?.aborted ? "aborted" : "error",
        error: providerErrorMessage(
          registeredModel,
          streamOptions?.signal?.aborted
            ? "controlled_transport_aborted"
            : safeProviderAdapterError(error)
        )
      });
    }
  })();
  return output;
}

/**
 * AgentSession passes AgentTool objects through pi-ai's structural Context
 * type. Their runtime-only execute/prepare callbacks must stay with the Agent
 * loop; the Provider boundary only needs the serializable tool declaration.
 */
function cloneProviderContext(
  context: Context,
  supportsToolCalling: boolean
): Context {
  return deepFreeze({
    ...(context.systemPrompt === undefined
      ? {}
      : { systemPrompt: context.systemPrompt }),
    messages: context.messages.map((message) => {
      if (message.role !== "toolResult") return structuredClone(message);
      const { details: _runtimeDetails, ...providerMessage } = message;
      return structuredClone(providerMessage);
    }),
    ...(!supportsToolCalling || context.tools === undefined
      ? {}
      : {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: structuredClone(tool.parameters),
            ...(tool.constrainedSampling === undefined
              ? {}
              : {
                  constrainedSampling: structuredClone(
                    tool.constrainedSampling
                  )
                })
          }))
        })
  });
}

function validateOptions(
  options: PiNativeControlledProviderOptions
): void {
  if (
    !options
    || typeof options.config?.read !== "function"
    || typeof options.controlledStream?.stream !== "function"
    || typeof options.currentExecutionContext !== "function"
    || !positiveSafeInteger(options.model?.contextWindow)
    || !positiveSafeInteger(options.model?.maxTokens)
    || (
      options.maxTokens !== undefined
      && (
        !positiveSafeInteger(options.maxTokens)
        || options.maxTokens > options.model.maxTokens
      )
    )
  ) {
    throw new PiNativeModelMetadataError(
      "model_metadata_incompatible",
      "Pi-native controlled Provider options are incompatible"
    );
  }
}

function captureExecutionContext(
  input: Readonly<PiNativeProviderExecutionContext>
): PiNativeProviderExecutionContext {
  const fields = [
    input?.runId,
    input?.conversationId,
    input?.turnId,
    input?.correlationId
  ];
  if (fields.some((value) => !safeIdentifier(value))) {
    throw new Error("provider_execution_context_unbound");
  }
  return Object.freeze({
    runId: input.runId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    correlationId: input.correlationId
  });
}

function requestMaxTokens(
  requested: number | undefined,
  configured: number | undefined,
  modelMaximum: number,
  required: boolean
): Readonly<{ maxTokens?: number }> {
  if (
    configured === undefined
    && requested === undefined
    && !required
  ) return {};
  const modelLimit = Math.min(modelMaximum, MAX_CONTROLLED_OUTPUT_TOKENS);
  const configuredLimit = boundedInteger(
    configured,
    1,
    modelLimit,
    modelLimit
  );
  const requestedLimit = boundedInteger(
    requested,
    1,
    modelLimit,
    modelLimit
  );
  return {
    maxTokens: Math.min(requestedLimit, configuredLimit, modelLimit)
  };
}

function hasAmbientCredential(
  options: SimpleStreamOptions | undefined
): boolean {
  if (!options) return false;
  if (typeof options.apiKey === "string" && options.apiKey.length > 0) {
    return true;
  }
  if (
    options.env
    && Object.keys(options.env).some((key) =>
      /(?:api.?key|token|secret|authorization|proxy)/iu.test(key)
    )
  ) {
    return true;
  }
  return Object.keys(options.headers ?? {}).some((key) =>
    /^(?:authorization|proxy-authorization|x-api-key)$/iu.test(key)
  );
}

function providerErrorMessage(
  model: Model<Api>,
  safeCode: string
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: safeCode === "controlled_transport_aborted"
      ? "aborted"
      : "error",
    errorMessage: safeCode,
    timestamp: Date.now()
  };
}

function safeProviderAdapterError(error: unknown): string {
  if (
    error instanceof Error
    && [
      "controlled_transport_required",
      "provider_configuration_changed",
      "provider_execution_context_unbound",
      "context_length_exceeded"
    ].includes(error.message)
  ) {
    return error.message;
  }
  return "controlled_transport_failed";
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Number.isSafeInteger(value)
    && value! >= minimum
    && value! <= maximum
    ? value!
    : fallback;
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    ? value
    : fallback;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
