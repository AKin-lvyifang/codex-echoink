import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { ApiProviderConfig, ApiProviderModelConfig } from "../settings/settings";
import { apiProviderRequestUrl } from "../settings/provider-presets";

export type MobileRequest = (request: RequestUrlParam) => Promise<Pick<RequestUrlResponse, "status" | "json">>;
type StoredAssistant = AssistantMessage & { mobileReasoning?: string; mobileResponseItems?: unknown[] };
const textContent = (message: Message) => typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
export function piModel(provider: ApiProviderConfig, model: ApiProviderModelConfig): Model<any> {
  return { id: model.id, name: model.displayName, api: provider.apiProtocol, provider: provider.runtimeProviderId || provider.id, baseUrl: provider.baseUrl, reasoning: model.reasoningEnabled, input: ["text"], contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
function usage(value: any, responses: boolean): Usage {
  const input = Number(responses ? value?.input_tokens : value?.prompt_tokens) || 0;
  const output = Number(responses ? value?.output_tokens : value?.completion_tokens) || 0;
  const cached = Number(responses ? value?.input_tokens_details?.cached_tokens : value?.prompt_tokens_details?.cached_tokens) || 0;
  return { input: Math.max(0, input - cached), output, cacheRead: cached, cacheWrite: 0, totalTokens: Number(value?.total_tokens) || input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function toolArguments(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型返回了无效的工具参数。");
  return parsed as Record<string, unknown>;
}
function transcript(context: Context, responses: boolean): any[] {
  const result: any[] = [];
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
export function buildMobileRequest(provider: ApiProviderConfig, model: Model<any>, context: Context): RequestUrlParam {
  const responses = provider.apiProtocol === "openai-responses";
  const tools = context.tools?.map(tool => responses
    ? { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }
    : { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } });
  const body = responses
    ? { model: model.id, stream: false, store: false, instructions: context.systemPrompt, input: transcript(context, true), max_output_tokens: model.maxTokens, include: ["reasoning.encrypted_content"], ...(tools?.length ? { tools } : {}) }
    : { model: model.id, stream: false, messages: [{ role: "system", content: context.systemPrompt }, ...transcript(context, false)], max_completion_tokens: model.maxTokens, ...(tools?.length ? { tools } : {}) };
  // Compatible endpoints generally use max_tokens; OpenAI reasoning models use
  // max_completion_tokens. Keep the protocol independent of a provider catalog.
  if (!responses && !/api\.openai\.com$/u.test(new URL(provider.baseUrl).hostname)) {
    (body as any).max_tokens = model.maxTokens;
    delete (body as any).max_completion_tokens;
  }
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
        const response = await abortable(request(buildMobileRequest(provider, model, context)), options?.signal);
        if (options?.signal?.aborted) throw new Error("已停止");
        const data = response.json;
        if (response.status < 200 || response.status >= 300 || data?.error || data?.status === "failed") {
          throw new Error(`Provider 请求失败（${response.status}）：${data?.error?.message || "请检查模型、接口地址和 API Key"}`);
        }
        const responses = provider.apiProtocol === "openai-responses";
        message.usage = usage(data?.usage, responses);
        message.responseId = data?.id;
        message.responseModel = data?.model;
        if (responses) {
          if (!Array.isArray(data?.output)) throw new Error("Provider 未返回有效的 Responses 结果。");
          message.mobileResponseItems = data.output.filter((item: any) => item.type === "reasoning");
          for (const item of data.output) {
            if (item.type === "message") for (const part of item.content ?? []) {
              if (part.type === "output_text") message.content.push({ type: "text", text: part.text });
              if (part.type === "refusal") message.content.push({ type: "text", text: part.refusal });
            }
            if (item.type === "function_call") {
              if (!item.call_id || !item.name) throw new Error("模型工具调用缺少标识。");
              message.content.push({ type: "toolCall", id: item.call_id, name: item.name, arguments: toolArguments(item.arguments) });
            }
          }
          if (data.status === "incomplete") message.stopReason = "length";
        } else {
          const choice = data?.choices?.[0];
          if (!choice?.message) throw new Error("Provider 未返回有效的 Chat Completions 结果。");
          if (typeof choice.message.content === "string" && choice.message.content) message.content.push({ type: "text", text: choice.message.content });
          if (typeof choice.message.reasoning_content === "string") message.mobileReasoning = choice.message.reasoning_content;
          if (choice.message.refusal) message.content.push({ type: "text", text: choice.message.refusal });
          for (const call of choice.message.tool_calls ?? []) {
            if (!call.id || !call.function?.name) throw new Error("模型工具调用缺少标识。");
            message.content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: toolArguments(call.function.arguments) });
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
