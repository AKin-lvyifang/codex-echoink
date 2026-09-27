import type {
  AssistantMessage,
  ProviderResponse,
  ProviderStreams
} from "@earendil-works/pi-ai";
import { requestUrl } from "obsidian";
import {
  PiProviderProtocolDispatcher,
  classifyPiProviderConnectionFailure,
  type PiProviderConnectionFailureKind
} from "../harness/pi/pi-provider-protocol-adapter";
import {
  providerFailureCodeFromError
} from "../harness/pi/provider-failure";
import {
  createPiNativeModelFromConfiguration
} from "../harness/pi-native/pi-native-controlled-provider";
import {
  isValidApiProviderModelId,
  type CodexForObsidianSettings
} from "../settings/settings";
import {
  resolveEchoInkPiCatalogModel,
  resolveEchoInkPiModelReasoningCapabilities
} from "../settings/pi-model-catalog";
import {
  apiProviderAuthMode,
  apiProviderApiKeyRequired,
  apiProviderModelsUrl,
  isLoopbackApiProviderUrl,
  normalizeApiProviderBaseUrl,
  normalizeApiProviderId,
  getApiProviderPreset,
  type ApiProviderAuthMode,
  type ApiProviderId,
  type ApiProviderProtocol
} from "../settings/provider-presets";
import {
  loopbackProviderFetch
} from "./loopback-openai-provider-adapter";
import {
  createConfiguredPiProviderProtocolDispatcher
} from "./configured-pi-provider-dispatcher";

const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const CODEX_CONNECTION_TIMEOUT_MS = 60_000;
const PROVIDER_MODEL_LIMIT = 200;

export interface PiProviderConfigurationDraft {
  readonly providerSettingsId: string;
  readonly providerId: ApiProviderId;
  readonly runtimeProviderId: string;
  readonly apiProtocol: ApiProviderProtocol;
  readonly authMode: ApiProviderAuthMode;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly toolCalling: boolean;
  readonly imageInput: boolean;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly modelMaxTokens: number;
  readonly maxOutputTokens: number;
}

export type PiProviderModelListStatus =
  | "available"
  | "unsupported"
  | "api_key_error"
  | "rate_or_service_error"
  | "network_error"
  | "response_format_error"
  | "temporary_failure";

export interface PiProviderModelListResult {
  readonly status: PiProviderModelListStatus;
  readonly models: readonly string[];
}

export type PiProviderConnectionFailure =
  PiProviderConnectionFailureKind;

export type PiProviderConnectionTestResult =
  | { readonly status: "available" }
  | {
    readonly status: "failed";
    readonly failure: PiProviderConnectionFailure;
  };

export interface PiProviderTextGenerationInput {
  readonly draft: PiProviderConfigurationDraft;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly timeoutMs: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface PiProviderConfigurationHost {
  readonly settings: CodexForObsidianSettings;
}

export type PiProviderFetch = (
  input: string,
  init: RequestInit
) => Promise<Pick<Response, "status" | "json">>;

export class PiProviderConfigurationService {
  constructor(
    private readonly host: PiProviderConfigurationHost,
    private readonly options: {
      fetchImpl?: PiProviderFetch;
      adapters?: Readonly<Partial<Record<ApiProviderProtocol, ProviderStreams>>>;
      textGenerationDispatcher?: Pick<PiProviderProtocolDispatcher, "stream">;
      resolveOAuthAccessToken?: () => Promise<string>;
      timeoutMs?: number;
    } = {}
  ) {}

  async listModels(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderModelListResult> {
    const normalized = normalizeDraft(draft, false);
    if (normalized.providerId === "openai-codex") {
      return {
        status: "available",
        models: getApiProviderPreset("openai-codex")
          .models.map((model) => model.id)
      };
    }
    let apiKey: string;
    try {
      apiKey = await this.resolveAuthToken(normalized);
    } catch {
      return { status: "api_key_error", models: [] };
    }
    return await requestProviderModels({
      draft: normalized,
      apiKey,
      fetchImpl: this.options.fetchImpl
        ?? providerModelFetchForUrl(normalized.baseUrl),
      timeoutMs: this.options.timeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS
    });
  }

  async testConnection(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderConnectionTestResult> {
    const normalized = normalizeDraft(draft, true);
    let apiKey: string;
    try {
      apiKey = await this.resolveAuthToken(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        status: "failed",
        failure: message === "provider_api_key_missing"
          || message === "provider_oauth_missing"
          ? "auth"
          : classifyPiProviderConnectionFailure(
            null,
            providerFailureCodeFromError(error) ?? message
          )
      };
    }
    return await testProviderConnection({
      draft: normalized,
      apiKey,
      dispatcher: this.options.adapters
        ? new PiProviderProtocolDispatcher(this.options.adapters)
        : createConfiguredPiProviderProtocolDispatcher(normalized),
      timeoutMs: this.options.timeoutMs
    });
  }

  async generateText(
    input: PiProviderTextGenerationInput
  ): Promise<string> {
    if (input.signal?.aborted) {
      throw new Error("provider_text_generation_aborted");
    }
    const normalized = normalizeDraft(input.draft, true);
    const apiKey = await this.resolveAuthToken(normalized);
    if (input.signal?.aborted) {
      throw new Error("provider_text_generation_aborted");
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, Math.min(120_000, input.timeoutMs));
    let abortKind: "external" | "timeout" | null = null;
    const abort = (kind: "external" | "timeout") => {
      if (abortKind) return;
      abortKind = kind;
      controller.abort();
    };
    const abortFromExternal = () => abort("external");
    input.signal?.addEventListener("abort", abortFromExternal, { once: true });
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    try {
      const dispatcher = this.options.textGenerationDispatcher
        ?? (this.options.adapters
          ? new PiProviderProtocolDispatcher(this.options.adapters)
          : createConfiguredPiProviderProtocolDispatcher(normalized));
      const stream = dispatcher.stream({
        model: createProviderModelFromDraft(normalized),
        context: {
          systemPrompt: input.systemPrompt,
          messages: [{
            role: "user",
            content: input.userPrompt,
            timestamp: Date.now()
          }],
          tools: []
        },
        apiKey,
        options: {
          signal: controller.signal,
          maxTokens: Math.max(1, Math.min(
            normalized.maxOutputTokens,
            input.maxTokens ?? 4_096
          )),
          temperature: 0,
          cacheRetention: "none",
          maxRetries: 0,
          timeoutMs
        }
      });
      const message = await stream.result();
      const text = assistantText(message);
      if (
        abortKind
        || message.stopReason !== "stop"
        || !text.trim()
      ) {
        throw new Error(abortKind === "external"
          ? "provider_text_generation_aborted"
          : abortKind === "timeout"
            ? "provider_text_generation_timeout"
          : "provider_text_generation_failed");
      }
      return text;
    } catch (error) {
      if (abortKind === "external") {
        throw new Error("provider_text_generation_aborted");
      }
      if (abortKind === "timeout") {
        throw new Error("provider_text_generation_timeout");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromExternal);
    }
  }

  private async resolveAuthToken(
    draft: PiProviderConfigurationDraft
  ): Promise<string> {
    if (draft.authMode === "oauth") {
      if (
        draft.providerId !== "openai-codex"
        || !this.options.resolveOAuthAccessToken
      ) throw new Error("provider_oauth_missing");
      return await this.options.resolveOAuthAccessToken();
    }
    if (draft.apiKey.trim()) return draft.apiKey.trim();
    if (!apiProviderApiKeyRequired(draft.providerId)) return "";
    const provider = this.host.settings.apiProviders.find(
      (candidate) => candidate.id === draft.providerSettingsId
    );
    const apiKey = provider?.apiKey.trim() ?? "";
    if (!apiKey) throw new Error("provider_api_key_missing");
    return apiKey;
  }
}

export async function requestProviderModels(input: {
  draft: PiProviderConfigurationDraft;
  apiKey: string;
  fetchImpl: PiProviderFetch;
  timeoutMs?: number;
}): Promise<PiProviderModelListResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS
  );
  try {
    const headers: Record<string, string> = input.draft.apiProtocol
      === "anthropic-messages"
      ? {
        ...(input.apiKey ? { "x-api-key": input.apiKey } : {}),
        "anthropic-version": "2023-06-01"
      }
      : input.apiKey
        ? { authorization: `Bearer ${input.apiKey}` }
        : {};
    const response = await abortableProviderRequest(
      input.fetchImpl(
        apiProviderModelsUrl(
          input.draft.baseUrl,
          input.draft.apiProtocol
        ),
        {
          method: "GET",
          headers,
          signal: controller.signal,
          redirect: "error"
        }
      ),
      controller.signal
    );
    if (response.status === 401 || response.status === 403) {
      return { status: "api_key_error", models: [] };
    }
    if ([404, 405, 501].includes(response.status)) {
      return { status: "unsupported", models: [] };
    }
    if (response.status === 429 || response.status >= 500) {
      return { status: "rate_or_service_error", models: [] };
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: "unsupported", models: [] };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: "response_format_error", models: [] };
    }
    const models = modelIdsFromResponse(body);
    return models === null
      ? { status: "response_format_error", models: [] }
      : { status: "available", models };
  } catch {
    return { status: "network_error", models: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export function createObsidianProviderFetch(
  requestImpl: typeof requestUrl = requestUrl
): PiProviderFetch {
  return async (input, init) => {
    const response = await requestImpl({
      url: input,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string> | undefined,
      throw: false
    });
    return {
      status: response.status,
      json: async (): Promise<unknown> => response.json as unknown
    };
  };
}

export const obsidianProviderFetch = createObsidianProviderFetch();

export function providerModelFetchForUrl(
  baseUrl: string,
  cloudFetch: PiProviderFetch = obsidianProviderFetch,
  localFetch: PiProviderFetch = loopbackProviderFetch
): PiProviderFetch {
  return isLoopbackApiProviderUrl(baseUrl) ? localFetch : cloudFetch;
}

function abortableProviderRequest<T>(
  request: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("provider_model_list_aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("provider_model_list_aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void request.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: Error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

export async function testProviderConnection(input: {
  draft: PiProviderConfigurationDraft;
  apiKey: string;
  dispatcher: PiProviderProtocolDispatcher;
  timeoutMs?: number;
}): Promise<PiProviderConnectionTestResult> {
  const controller = new AbortController();
  const codex = input.draft.providerId === "openai-codex";
  const timeoutMs = input.timeoutMs ?? (codex
    ? CODEX_CONNECTION_TIMEOUT_MS
    : PROVIDER_REQUEST_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let responseStatus: number | null = null;
  try {
    const model = createProviderModelFromDraft(input.draft);
    const reasoning = codex
      ? resolveEchoInkPiModelReasoningCapabilities(model)
        .enabledOptions[0]?.piLevel
      : undefined;
    const stream = input.dispatcher.stream({
      model,
      context: {
        systemPrompt: "Connection check. Reply with OK only.",
        messages: [{
          role: "user",
          content: "只回复 OK",
          timestamp: Date.now()
        }],
        tools: []
      },
      apiKey: input.apiKey,
      options: {
        signal: controller.signal,
        ...(reasoning && reasoning !== "off" ? { reasoning } : {}),
        maxTokens: 32,
        temperature: 0,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs,
        onResponse: (response: ProviderResponse) => {
          responseStatus = response.status;
        }
      }
    });
    const message = await stream.result();
    if (controller.signal.aborted) {
      return { status: "failed", failure: "timeout" };
    }
    if (
      message.stopReason === "stop"
      && assistantText(message).trim().length > 0
    ) {
      return { status: "available" };
    }
    return {
      status: "failed",
      failure: classifyPiProviderConnectionFailure(
        responseStatus,
        message.errorMessage ?? ""
      )
    };
  } catch (error) {
    return {
      status: "failed",
      failure: controller.signal.aborted
        ? "timeout"
        : classifyPiProviderConnectionFailure(
          responseStatus,
          error instanceof Error ? error.message : ""
        )
    };
  } finally {
    clearTimeout(timer);
  }
}

function createProviderModelFromDraft(
  draft: PiProviderConfigurationDraft
) {
  return createPiNativeModelFromConfiguration({
    catalogModel: resolveEchoInkPiCatalogModel(
      draft.runtimeProviderId,
      draft.modelId
    ) ?? undefined,
    provider: {
      providerId: draft.runtimeProviderId,
      apiProtocol: draft.apiProtocol,
      authMode: draft.authMode,
      baseUrl: draft.baseUrl,
      modelRef: draft.modelId
    },
    configured: {
      apiProtocol: draft.apiProtocol,
      contextWindow: draft.contextWindow,
      maxOutputTokens: draft.modelMaxTokens,
      reasoning: draft.reasoning,
      imageInput: draft.imageInput
    }
  });
}

function normalizeDraft(
  draft: PiProviderConfigurationDraft,
  requireModel: boolean
): PiProviderConfigurationDraft {
  const modelId = draft.modelId.trim();
  if (requireModel && !isValidApiProviderModelId(modelId)) {
    throw new Error("provider_model_invalid");
  }
  if (
    draft.authMode !== apiProviderAuthMode(draft.providerId)
    || (
      draft.providerId === "openai-codex"
      && draft.apiProtocol !== "openai-codex-responses"
    )
    ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(
      draft.runtimeProviderId.trim()
    )
    || !Number.isSafeInteger(draft.contextWindow)
    || draft.contextWindow < 1_024
    || draft.contextWindow > 2_000_000
    || !Number.isSafeInteger(draft.modelMaxTokens)
    || draft.modelMaxTokens < 1
    || draft.modelMaxTokens > 1_000_000
    || !Number.isSafeInteger(draft.maxOutputTokens)
    || draft.maxOutputTokens < 1
    || draft.maxOutputTokens > Math.min(
      draft.contextWindow,
      draft.modelMaxTokens,
      1_000_000
    )
  ) {
    throw new Error("provider_model_metadata_invalid");
  }
  return Object.freeze({
    providerSettingsId: draft.providerSettingsId,
    providerId: draft.providerId,
    runtimeProviderId: draft.runtimeProviderId.trim(),
    apiProtocol: draft.apiProtocol,
    authMode: draft.authMode,
    baseUrl: normalizeApiProviderBaseUrl(
      draft.baseUrl,
      draft.apiProtocol
    ),
    modelId,
    apiKey: draft.apiKey.trim(),
    toolCalling: draft.toolCalling,
    imageInput: draft.imageInput,
    reasoning: draft.reasoning,
    contextWindow: draft.contextWindow,
    modelMaxTokens: draft.modelMaxTokens,
    maxOutputTokens: draft.maxOutputTokens
  });
}

function modelIdsFromResponse(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.data) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (!isValidApiProviderModelId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= PROVIDER_MODEL_LIMIT) break;
  }
  return ids;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}
