import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Message, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { RequestUrlParam } from "obsidian";
import type { ApiProviderConfig, ApiProviderModelConfig } from "../settings/settings";
import { apiProviderRequestUrl } from "../settings/provider-presets";
import { applyEchoInkProviderReasoningWirePolicy, resolveEchoInkProviderReasoningWirePolicy, withEchoInkProviderReasoningWirePolicy } from "../harness/pi/provider-reasoning-wire-policy";
import { observeUsageStream, type ObserveUsageOptions, type UsageSource } from "../harness/usage/usage-stream";
import { countTextTokens, estimateTokenValue } from "../harness/usage/token-estimator";

export type MobileRequest = (request: RequestUrlParam) => Promise<{ status: number; json: unknown }>;
/** WebView fetch subset: requestUrl buffers the whole body, so streaming needs fetch. */
export type MobileStreamFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<MobileStreamResponse>;
export interface MobileStreamResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  text(): Promise<string>;
}
export type MobileUsageObserver = Pick<ObserveUsageOptions, "recordUsage" | "onRecordError">;
export const MOBILE_STREAM_BLOCKED = "流式请求没有连上。此服务可能不允许手机直接流式访问，可在模型服务的「参数」里关闭「流式输出」后重试。";
/** Undefined where the WebView has no fetch (test hosts); callers then keep requestUrl. */
export function webviewFetch(): MobileStreamFetch | undefined {
  const fetch = typeof window === "undefined" ? undefined : window.fetch?.bind(window);
  return fetch ? (url, init) => fetch(url, init) : undefined;
}
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
function visibleReasoningTokens(item: Record<string, unknown>): number {
  if (item.type !== "reasoning") return 0;
  return [...records(item.summary).filter(part => part.type === "summary_text"),
    ...records(item.content).filter(part => part.type === "reasoning_text")]
    .reduce((total, part) => total + (typeof part.text === "string" ? countTextTokens(part.text) : 0), 0);
}
function transcriptReasoningTokens(context: Context, responses: boolean): number {
  return transcript(context, responses).reduce<number>((total, value) => {
    const item = record(value);
    return total + (responses ? visibleReasoningTokens(item) : typeof item.reasoning_content === "string" ? countTextTokens(item.reasoning_content) : 0);
  }, 0);
}
function returnedToolTokens(name: unknown, args: unknown): number {
  if (typeof name !== "string" || !name) return 0;
  try { return estimateTokenValue({ name, arguments: toolArguments(args) }); }
  catch { return countTextTokens(name) + (typeof args === "string" ? countTextTokens(args) : 0); }
}
/** Numeric snapshot only: parsing failure must not erase already-returned text. */
function returnedOutputTokens(data: Record<string, unknown>, responses: boolean): number {
  if (responses) return records(data.output).reduce((total, item) => total + visibleReasoningTokens(item)
    + (item.type === "message" ? records(item.content).reduce((sum, part) => sum
      + (part.type === "output_text" && typeof part.text === "string" ? countTextTokens(part.text) : 0)
      + (part.type === "refusal" && typeof part.refusal === "string" ? countTextTokens(part.refusal) : 0), 0) : 0)
    + (item.type === "function_call" ? returnedToolTokens(item.name, item.arguments) : 0), 0);
  const content = record(records(data.choices)[0]?.message);
  return [content.content, content.reasoning_content, content.refusal].reduce<number>((total, value) => total + (typeof value === "string" ? countTextTokens(value) : 0), 0)
    + records(content.tool_calls).reduce((total, call) => { const fn = record(call.function); return total + returnedToolTokens(fn.name, fn.arguments); }, 0);
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
export function buildMobileRequest(provider: ApiProviderConfig, model: Model<Api>, context: Context, reasoning?: ModelThinkingLevel, stream = false): RequestUrlParam {
  const responses = provider.apiProtocol === "openai-responses";
  const tools = context.tools?.map(tool => responses
    ? { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }
    : { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } });
  const body: Record<string, unknown> = responses
    ? { model: model.id, stream, store: false, instructions: context.systemPrompt, input: transcript(context, true), max_output_tokens: model.maxTokens, include: ["reasoning.encrypted_content"], ...(tools?.length ? { tools } : {}) }
    : { model: model.id, stream, messages: [{ role: "system", content: context.systemPrompt }, ...transcript(context, false)], max_completion_tokens: model.maxTokens, ...(tools?.length ? { tools } : {}) };
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
/** With streamFetch the answer streams; the stored message keeps the buffered shape either way. */
export function mobileStream(provider: ApiProviderConfig, request: MobileRequest, observer?: MobileUsageObserver, source: UsageSource = "conversation", streamFetch?: MobileStreamFetch): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    let outputTokens = 0;
    const message: StoredAssistant = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usage(null, false), stopReason: "stop", timestamp: Date.now() };
    // A separate partial: late chunks after Stop can never touch the stored message.
    const live = streamFetch ? new LiveAssistant(stream, { ...message, content: [] }, options?.signal) : undefined;
    void (async () => {
      try {
        if (options?.signal?.aborted) throw new Error("已停止");
        stream.push({ type: "start", partial: live?.partial ?? message });
        const built = buildMobileRequest(provider, model, context, options?.reasoning, !!live);
        const response = await abortable(live && streamFetch
          ? streamedResponse(streamFetch, built, provider.apiProtocol === "openai-responses", live, options?.signal)
          : request(built), options?.signal);
        if (options?.signal?.aborted) throw new Error("已停止");
        const data = record(response.json);
        const responses = provider.apiProtocol === "openai-responses";
        if (observer) outputTokens = returnedOutputTokens(data, responses);
        if (response.status < 200 || response.status >= 300 || data.error || data.status === "failed") {
          const providerError = record(data.error).message;
          throw new Error(`Provider 请求失败（${response.status}）：${typeof providerError === "string" && providerError || "请检查模型、接口地址和 API Key"}`);
        }
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
        // Partial streamed output still counts toward usage.
        if (observer && live && !outputTokens) outputTokens = live.tokens();
        message.content = [];
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        const detail = error instanceof Error ? error.message : String(error);
        message.errorMessage = provider.apiKey ? detail.split(provider.apiKey).join("[已隐藏]") : detail;
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally { stream.end(message); }
    })();
    return observer ? observeUsageStream(stream, { ...observer, context, provider: model.provider, model: model.id, source,
      additionalInputTokens: transcriptReasoningTokens(context, provider.apiProtocol === "openai-responses"), estimateOutputTokens: () => outputTokens }) : stream;
  };
}

/** Streams SSE into `live` and rebuilds the buffered JSON shape for the shared parser. */
async function streamedResponse(streamFetch: MobileStreamFetch, built: RequestUrlParam, responses: boolean, live: LiveAssistant, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
  let response: MobileStreamResponse;
  try {
    response = await streamFetch(built.url, { method: "POST", headers: { ...built.headers, "Content-Type": "application/json" }, body: typeof built.body === "string" ? built.body : "", signal });
  } catch (error) {
    if (signal?.aborted) throw new Error("已停止");
    // WebView rejects without detail when CORS or the network blocks the call.
    throw new Error(MOBILE_STREAM_BLOCKED, { cause: error });
  }
  if (!/^text\/event-stream/iu.test(response.headers.get("content-type") ?? "")) {
    // Errors (401, 429 …) and endpoints that ignore `stream` answer plain JSON.
    const text = await response.text();
    try { return { status: response.status, json: JSON.parse(text) as unknown }; } catch { return { status: response.status, json: {} }; }
  }
  const sse = responses ? new ResponsesStream(live) : new ChatStream(live);
  const decoder = new TextDecoder(); let buffer = "";
  const reader = response.body?.getReader();
  if (!reader) buffer = drainSse(await response.text() + "\n\n", data => sse.push(data));
  else try {
    let received = false;
    for (;;) {
      if (signal?.aborted) throw new Error("已停止");
      let chunk: { done: boolean; value?: Uint8Array };
      try { chunk = await reader.read(); }
      catch (error) {
        if (signal?.aborted) throw new Error("已停止");
        throw new Error(received ? "回答传输中断，请重试。" : MOBILE_STREAM_BLOCKED, { cause: error });
      }
      if (chunk.done) break;
      received = true;
      buffer = drainSse(buffer + decoder.decode(chunk.value, { stream: true }), data => sse.push(data));
    }
  } finally { void reader.cancel().catch(() => undefined); }
  drainSse(buffer + decoder.decode() + "\n\n", data => sse.push(data));
  live.close();
  return { status: response.status, json: sse.result() };
}
/** Emits each complete SSE `data:` payload and returns the unfinished tail. */
function drainSse(buffer: string, emit: (data: string) => void): string {
  const blocks = buffer.split(/\r?\n\r?\n/u), rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /u, "")).join("\n");
    if (data) emit(data);
  }
  return rest;
}
function streamChunk(data: string): Record<string, unknown> {
  try { return record(JSON.parse(data)); } catch { throw new Error("Provider 返回了无法解析的流式数据。"); }
}
function streamFailure(value: unknown): Error {
  const message = record(value).message;
  return new Error(`Provider 请求失败：${typeof message === "string" && message || "流式回答返回错误"}`);
}
/** Chat Completions deltas → the same object a `stream:false` call returns. */
class ChatStream {
  private readonly data: Record<string, unknown> = {};
  private text = ""; private reasoning?: string; private refusal = ""; private finish = ""; private done = false;
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  constructor(private readonly live: LiveAssistant) {}
  push(raw: string): void {
    if (raw === "[DONE]") { this.done = true; return; }
    const chunk = streamChunk(raw);
    if (chunk.error) throw streamFailure(chunk.error);
    for (const key of ["id", "model"] as const) if (typeof chunk[key] === "string") this.data[key] ??= chunk[key];
    if (chunk.usage && typeof chunk.usage === "object") this.data.usage = chunk.usage;
    const choice = records(chunk.choices)[0];
    if (!choice) return;
    // Kimi reports usage on the final choice instead of the chunk.
    if (choice.usage && typeof choice.usage === "object") this.data.usage = choice.usage;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) this.finish = choice.finish_reason;
    const delta = record(choice.delta);
    if (typeof delta.reasoning_content === "string") { this.reasoning = (this.reasoning ?? "") + delta.reasoning_content; this.live.thinking(delta.reasoning_content); }
    if (typeof delta.content === "string") { this.text += delta.content; this.live.text(delta.content); }
    if (typeof delta.refusal === "string") { this.refusal += delta.refusal; this.live.text(delta.refusal); }
    for (const call of records(delta.tool_calls)) {
      const index = Number.isSafeInteger(call.index) ? Number(call.index) : 0, fn = record(call.function);
      const state = this.calls.get(index) ?? { id: "", name: "", args: "" }; this.calls.set(index, state);
      if (typeof call.id === "string" && call.id) state.id = call.id;
      if (typeof fn.name === "string") state.name += fn.name;
      if (typeof fn.arguments === "string") state.args += fn.arguments;
    }
  }
  result(): Record<string, unknown> {
    if (!this.finish && !this.done) throw new Error("回答传输中断，请重试。");
    const toolCalls = [...this.calls].sort(([a], [b]) => a - b).map(([, call]) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args || "{}" } }));
    const message: Record<string, unknown> = { role: "assistant", content: this.text, ...(this.reasoning !== undefined ? { reasoning_content: this.reasoning } : {}), ...(this.refusal ? { refusal: this.refusal } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    return { ...this.data, choices: [{ message, finish_reason: this.finish || "stop" }] };
  }
}
/** Responses events; the terminal event already carries the full response object. */
class ResponsesStream {
  private final?: Record<string, unknown>;
  constructor(private readonly live: LiveAssistant) {}
  push(raw: string): void {
    if (raw === "[DONE]") return;
    const event = streamChunk(raw), type = event.type;
    if (type === "error") throw streamFailure(event);
    if ((type === "response.output_text.delta" || type === "response.refusal.delta") && typeof event.delta === "string") this.live.text(event.delta);
    else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof event.delta === "string") this.live.thinking(event.delta);
    else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") this.final = record(event.response);
  }
  result(): Record<string, unknown> {
    if (!this.final) throw new Error("回答传输中断，请重试。");
    return this.final;
  }
}
/** Live-only partial for the UI; the stored message is rebuilt by the shared parser. */
class LiveAssistant {
  private active?: { kind: "thinking" | "text"; index: number };
  constructor(private readonly stream: AssistantMessageEventStream, readonly partial: AssistantMessage, private readonly signal?: AbortSignal) {}
  thinking(delta: string): void {
    if (!delta || this.signal?.aborted) return;
    if (this.active?.kind !== "thinking") { this.close(); this.active = { kind: "thinking", index: this.partial.content.length }; this.partial.content.push({ type: "thinking", thinking: "" }); this.stream.push({ type: "thinking_start", contentIndex: this.active.index, partial: this.partial }); }
    const index = this.active.index, block = this.partial.content[index];
    if (block?.type === "thinking") block.thinking += delta;
    this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.partial });
  }
  text(delta: string): void {
    if (!delta || this.signal?.aborted) return;
    if (this.active?.kind !== "text") { this.close(); this.active = { kind: "text", index: this.partial.content.length }; this.partial.content.push({ type: "text", text: "" }); this.stream.push({ type: "text_start", contentIndex: this.active.index, partial: this.partial }); }
    const index = this.active.index, block = this.partial.content[index];
    if (block?.type === "text") block.text += delta;
    this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.partial });
  }
  close(): void {
    const active = this.active; this.active = undefined;
    const block = active && this.partial.content[active.index];
    if (!active || !block || this.signal?.aborted) return;
    if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: active.index, content: block.thinking, partial: this.partial });
    else if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: active.index, content: block.text, partial: this.partial });
  }
  tokens(): number {
    return this.partial.content.reduce((total, block) => total + (block.type === "text" ? countTextTokens(block.text) : block.type === "thinking" ? countTextTokens(block.thinking) : 0), 0);
  }
}
/** Reasoning text the UI may show for a stored or live assistant message. */
export function visibleReasoning(message: AssistantMessage): string {
  const stored = message as StoredAssistant;
  if (typeof stored.mobileReasoning === "string") return stored.mobileReasoning.trim();
  const items = records(stored.mobileResponseItems).flatMap(item => [...records(item.summary), ...records(item.content)])
    .flatMap(part => typeof part.text === "string" ? [part.text] : []);
  if (items.length) return items.join("\n\n").trim();
  return message.content.flatMap(block => block.type === "thinking" ? [block.thinking] : []).join("\n\n").trim();
}

/** Independent one-shot inference: no conversation state or tools are involved. */
export async function mobileGenerateText(provider: ApiProviderConfig, model: ApiProviderModelConfig, request: MobileRequest,
  systemPrompt: string, user: string, maxTokens: number, signal: AbortSignal, observer?: MobileUsageObserver, source: UsageSource = "background", streamFetch?: MobileStreamFetch): Promise<string> {
  const selected = { ...piModel(provider, model), maxTokens: Math.min(model.maxOutputTokens, maxTokens) };
  const stream = await mobileStream(provider, request, observer, source, streamFetch)(selected, { systemPrompt, messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { signal });
  const result = await stream.result();
  if (signal.aborted || result.stopReason === "aborted") throw new Error("已停止");
  if (result.stopReason === "error") throw new Error(result.errorMessage || "模型请求失败");
  if (result.stopReason === "length") throw new Error("模型输出未完整返回，请调整模型输出上限后重试。");
  return textContent(result);
}
