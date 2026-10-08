import { withEchoInkProviderReasoningWirePolicy } from "./provider-reasoning-wire-policy";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions
} from "@earendil-works/pi-ai";
import type {
  ApiProviderAuthMode,
  ApiProviderProtocol
} from "../../settings/provider-presets";

/** Provider runtime metadata. API keys stay in plugin settings and are read by
 * the transport at request time; they are never copied into this metadata. */
export interface PiProviderRuntimeConfig {
  providerId: string;
  apiProtocol: ApiProviderProtocol;
  authMode: ApiProviderAuthMode;
  baseUrl: string;
  modelRef: string;
}

export interface PiProviderRuntimeConfigPort {
  read(): Promise<PiProviderRuntimeConfig | null>;
}

export interface ControlledPiStreamInput {
  runId: string;
  conversationId: string;
  turnId: string;
  correlationId: string;
  provider: PiProviderRuntimeConfig;
  model: Model<Api>;
  context: Context;
  options: {
    signal?: AbortSignal;
    reasoning?: SimpleStreamOptions["reasoning"];
    maxTokens?: number;
    temperature: number;
    cacheRetention: "none";
    maxRetries: 0;
    timeoutMs: number;
  };
}

export interface ControlledPiStreamPort {
  readonly authorityId: string;
  readonly storeSetId: string;
  stream(
    input: ControlledPiStreamInput
  ): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
}

export function createPiProviderModelDefinition(input: {
  providerId: string;
  apiProtocol: ApiProviderProtocol;
  baseUrl: string;
  modelRef: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  imageInput?: boolean;
}): Model<Api> {
  const model: Model<Api> = {
    id: input.modelRef,
    name: input.modelRef,
    api: input.apiProtocol,
    provider: input.providerId,
    baseUrl: input.baseUrl,
    reasoning: input.reasoning === true,
    input: input.imageInput === true ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: boundedInteger(
      input.contextWindow,
      1_024,
      2_000_000,
      64_000
    ),
    maxTokens: boundedInteger(
      input.maxOutputTokens,
      1,
      1_000_000,
      8_192
    )
  };
  if (input.apiProtocol === "openai-completions") {
    model.compat = {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      supportsReasoningEffort: input.reasoning === true,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: false
    };
  }
  return withEchoInkProviderReasoningWirePolicy(model);
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
