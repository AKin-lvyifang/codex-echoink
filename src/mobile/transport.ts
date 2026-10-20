import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Message, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { RequestUrlParam } from "obsidian";
import type { ApiProviderConfig, ApiProviderModelConfig } from "../settings/settings";
import { apiProviderRequestUrl } from "../settings/provider-presets";
import { applyEchoInkProviderReasoningWirePolicy, resolveEchoInkProviderReasoningWirePolicy, withEchoInkProviderReasoningWirePolicy } from "../harness/pi/provider-reasoning-wire-policy";

export type MobileRequest = (request: RequestUrlParam) => Promise<{ status: number; json: unknown }>;
type StoredAssistant = AssistantMessage & { mobileReasoning?: string; mobileResponseItems?: unknown[] };
type MobilePiModel = Model<Api> & { mobileReasoningLevel: ModelThinkingLevel };
const textContent = (message: Message) => typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
export function piModel(provider: ApiProviderConfig, model: ApiProviderModelConfig): MobilePiModel {
  const runtimeProviderId = provider.runtimeProviderId || provider.providerId || provider.id;
  const policy = resolveEchoInkProviderReasoningWirePolicy(runtimeProviderId, model.id);
  const level = model.reasoningEffort ?? model.discovery?.defaultReasoningEffort ?? policy?.defaultLevel ?? "medium";
  return {
    ...withEchoInkProviderReasoningWirePolicy({ id: model.id, name: model.displayName, api: provider.apiProtocol, provider: runtimeProviderId, baseUrl: provider.baseUrl, reasoning: model.reasoning, input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    mobileReasoningLevel: model.reasoning && model.reasoningEnabled && level !== "none" ? level : "off"
  };
}

/** Mirror the known desktop wire formats without importing its model catalog. */
function applyMobileReasoning(body: Record<string, unknown>, provider: ApiProviderConfig, model: Model<Api>, requested?: ModelThinkingLevel): void {
  const level = (model as Partial<MobilePiModel>).mobileReasoningLevel ?? requested ?? "off";
  const enabled = model.reasoning && level !== "off";
  const mapped = enabled ? model.thinkingLevelMap?.[level] : model.thinkingLevelMap?.off;
  const effort = mapped === null ? undefined : mapped ?? (enabled ? level : undefined);
  const identities = [provider.providerId, model.provider];
  const host = new URL(provider.baseUrl).hostname;
  const isHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  const deepseek = identities.includes("deepseek") || isHost("deepseek.com");
  const glm = identities.some(id => id === "glm" || id === "zai" || id === "zai-coding-cn") || isHost("z.ai") || isHost("bigmodel.cn");
  const qwen = identities.some(id => id === "qwen" || id === "qwen-token-plan" || id === "qwen-token-plan-cn") || isHost("dashscope.aliyuncs.com") || isHost("maas.aliyuncs.com");
  const kimi = identities.some(id => id === "kimi" || id === "moonshotai" || id === "moonshotai-cn") || isHost("moonshot.cn") || isHost("moonshot.ai");
  const openai = identities.includes("openai") || host === "api.openai.com";
  if (provider.apiProtocol === "openai-responses") {
    if (!model.reasoning || !openai) return;
    // O-series models have no real off state; leave their provider default alone.
    if (!enabled && (mapped === null || /^o[1-9](?:-|$)/u.test(model.id))) return;
    if (effort || !enabled) body.reasoning = { effort: effort ?? "none" };
    return;
  }
  if (provider.apiProtocol !== "openai-completions") return;
  if (deepseek || (qwen && /^deepseek-v4-/u.test(model.id))) {
    body.thinking = { type: enabled ? "enabled" : "disabled" };
    if (effort) body.reasoning_effort = /^deepseek-v4-/u.test(model.id) ? (effort === "max" || effort === "xhigh" ? "max" : "high") : effort;
  } else if (glm) {
    body.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
  } else if (qwen) {
    if (!model.reasoning && !/^qwen3(?:[.-]|$)/u.test(model.id)) return;
    const policyBody = applyEchoInkProviderReasoningWirePolicy(body, model, level);
    if (policyBody !== body) Object.assign(body, policyBody);
    else body.enable_thinking = enabled;
  } else if (kimi && (model.reasoning || /^kimi-k2\.[56](?:-|$)/u.test(model.id)) && /^kimi-k2/u.test(model.id)) {
    if (!enabled && (/^kimi-k2\.7-code/u.test(model.id) || mapped === null)) return;
    body.thinking = { type: enabled ? "enabled" : "disabled" };
  } else if (openai && model.reasoning && effort) body.reasoning_effort = effort;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function records(value: unknown): Record<string, unknown>[] {
  const items: unknown[] = Array.isArray(value) ? value : [];
  return items.map(record);
}
function usage(value: unknown, responses: boolean): Usage {
  const data = record(value);
  const input = Number(responses ? data.input_tokens : data.prompt_tokens) || 0;
  const output = Number(responses ? data.output_tokens : data.completion_tokens) || 0;
  const cached = Number(record(responses ? data.input_tokens_details : data.prompt_tokens_details).cached_tokens) || 0;
  return { input: Math.max(0, input - cached), output, cacheRead: cached, cacheWrite: 0, totalTokens: Number(data.total_tokens) || input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function toolArguments(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型返回了无效的工具参数。");
  return parsed as Record<string, unknown>;
}
function transcript(context: Context, responses: boolean): unknown[] {
  const result: unknown[] = [];
  const completed = new Set(context.messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
  for (const message of context.messages) {
    if (message.role === "user") result.push({ role: "user", content: textContent(message) });
    else if (message.role === "toolResult") {
      result.push(responses ? { type: "function_call_output", call_id: message.toolCallId, output: textContent(message) } : { role: "tool", tool_call_id: message.toolCallId, content: textContent(message) });
    } else {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const calls = message.content.filter(c => c.type === "toolCall" && completed.has(c.id));
      const text = textContent(message);
      if (responses) {
        result.push(...((message as StoredAssistant).mobileResponseItems ?? []));
        // EasyInputMessage accepts assistant history as text. output_text blocks
        // instead require the complete ResponseOutputMessage id/type/status shape.
        if (text) result.push({ role: "assistant", content: text });
        for (const call of calls) if (call.type === "toolCall") result.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
      } else if (text || calls.length) {
        result.push({ role: "assistant", content: text || null, ...((message as StoredAssistant).mobileReasoning ? { reasoning_content: (message as StoredAssistant).mobileReasoning } : {}), ...(calls.length ? { tool_calls: calls.map(c => c.type === "toolCall" ? { id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } } : null) } : {}) });
      }
    }
  }
  return result;
}
export function buildMobileRequest(provider: ApiProviderConfig, model: Model<Api>, context: Context, reasoning?: ModelThinkingLevel): RequestUrlParam {
  const responses = provider.apiProtocol === "openai-responses";
  const tools = context.tools?.map(tool => responses
    ? { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }
    : { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } });
  const body: Record<string, unknown> = responses
    ? { model: model.id, stream: false, store: false, instructions: context.systemPrompt, input: transcript(context, true), max_output_tokens: model.maxTokens, include: ["reasoning.encrypted_content"], ...(tools?.length ? { tools } : {}) }
    : { model: model.id, stream: false, messages: [{ role: "system", content: context.systemPrompt }, ...transcript(context, false)], max_completion_tokens: model.maxTokens, ...(tools?.length ? { tools } : {}) };
  // Compatible endpoints generally use max_tokens; OpenAI reasoning models use
  // max_completion_tokens. Keep the protocol independent of a provider catalog.
  if (!responses && !/api\.openai\.com$/u.test(new URL(provider.baseUrl).hostname)) {
    body.max_tokens = model.maxTokens;
    delete body.max_completion_tokens;
  }
  applyMobileReasoning(body, provider, model, reasoning);
  const url = new URL(apiProviderRequestUrl(provider.baseUrl, provider.apiProtocol));
  for (const [key, value] of Object.entries(provider.queryParams ?? {})) url.searchParams.set(key, value);
  return { url: url.toString(), method: "POST", contentType: "application/json", headers: provider.apiKey.trim() ? { Authorization: `Bearer ${provider.apiKey.trim()}` } : {}, body: JSON.stringify(body), throw: false };
}
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("已停止"));
    if (signal.aborted) { reject(new Error("已停止")); return; }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function mobileStream(provider: ApiProviderConfig, request: MobileRequest): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message: StoredAssistant = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usage(null, false), stopReason: "stop", timestamp: Date.now() };
    void (async () => {
      try {
        if (options?.signal?.aborted) throw new Error("已停止");
        stream.push({ type: "start", partial: message });
        const response = await abortable(request(buildMobileRequest(provider, model, context, options?.reasoning)), options?.signal);
        if (options?.signal?.aborted) throw new Error("已停止");
        const data = record(response.json);
        if (response.status < 200 || response.status >= 300 || data.error || data.status === "failed") {
          const providerError = record(data.error).message;
          throw new Error(`Provider 请求失败（${response.status}）：${typeof providerError === "string" && providerError || "请检查模型、接口地址和 API Key"}`);
        }
        const responses = provider.apiProtocol === "openai-responses";
        message.usage = usage(data.usage, responses);
        message.responseId = typeof data.id === "string" ? data.id : undefined;
        message.responseModel = typeof data.model === "string" ? data.model : undefined;
        if (responses) {
          if (!Array.isArray(data.output)) throw new Error("Provider 未返回有效的 Responses 结果。");
          const output = records(data.output);
          message.mobileResponseItems = output.filter(item => item.type === "reasoning");
          for (const item of output) {
            if (item.type === "message") for (const part of records(item.content)) {
              if (part.type === "output_text" && typeof part.text === "string") message.content.push({ type: "text", text: part.text });
              if (part.type === "refusal" && typeof part.refusal === "string") message.content.push({ type: "text", text: part.refusal });
            }
            if (item.type === "function_call") {
              if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name) throw new Error("模型工具调用缺少标识。");
              message.content.push({ type: "toolCall", id: item.call_id, name: item.name, arguments: toolArguments(item.arguments) });
            }
          }
          if (data.status === "incomplete") message.stopReason = "length";
        } else {
          const choice = records(data.choices)[0];
          if (!choice?.message) throw new Error("Provider 未返回有效的 Chat Completions 结果。");
          const content = record(choice.message);
          if (typeof content.content === "string" && content.content) message.content.push({ type: "text", text: content.content });
          if (typeof content.reasoning_content === "string") message.mobileReasoning = content.reasoning_content;
          if (typeof content.refusal === "string" && content.refusal) message.content.push({ type: "text", text: content.refusal });
          for (const call of records(content.tool_calls)) {
            const fn = record(call.function);
            if (typeof call.id !== "string" || !call.id || typeof fn.name !== "string" || !fn.name) throw new Error("模型工具调用缺少标识。");
            message.content.push({ type: "toolCall", id: call.id, name: fn.name, arguments: toolArguments(fn.arguments) });
          }
          if (choice.finish_reason === "length") message.stopReason = "length";
          if (choice.finish_reason === "content_filter") throw new Error("Provider 内容过滤，未完成本轮回答。");
        }
        if (message.content.some(c => c.type === "toolCall")) message.stopReason = "toolUse";
        stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
      } catch (error) {
        message.content = [];
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        const detail = error instanceof Error ? error.message : String(error);
        message.errorMessage = provider.apiKey ? detail.split(provider.apiKey).join("[已隐藏]") : detail;
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally { stream.end(message); }
    })();
    return stream;
  };
}

/** Independent one-shot inference: no conversation state or tools are involved. */
export async function mobileGenerateText(provider: ApiProviderConfig, model: ApiProviderModelConfig, request: MobileRequest,
  systemPrompt: string, user: string, maxTokens: number, signal: AbortSignal): Promise<string> {
  const selected = { ...piModel(provider, model), maxTokens: Math.min(model.maxOutputTokens, maxTokens) };
  const stream = await mobileStream(provider, request)(selected, { systemPrompt, messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { signal });
  const result = await stream.result();
  if (signal.aborted || result.stopReason === "aborted") throw new Error("已停止");
  if (result.stopReason === "error") throw new Error(result.errorMessage || "模型请求失败");
  if (result.stopReason === "length") throw new Error("模型输出未完整返回，请调整模型输出上限后重试。");
  return textContent(result);
}
