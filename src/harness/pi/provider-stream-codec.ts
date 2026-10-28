import { Buffer } from "node:buffer";
import {
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type Usage
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type {
  ControlledPiStreamInput
} from "./production-pi-model-resolver";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface ProviderSseResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ProviderSseStreamDecoder {
  readonly partial: AssistantMessage;
  push(chunk: Uint8Array | string): void;
  finish(): AssistantMessage;
}

/**
 * Incremental OpenAI-compatible SSE decoder used by the Node-only Provider
 * transports. It emits Pi events as bytes arrive instead of rebuilding one
 * buffered AssistantMessage after the HTTP response ends.
 */
export function createProviderSseStreamDecoder(input: {
  stream: AssistantMessageEventStream;
  model: Model<Api>;
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  timestamp: number;
}): ProviderSseStreamDecoder {
  if (
    input.statusCode < 200
    || input.statusCode >= 300
    || !Number.isFinite(input.timestamp)
    || !/^text\/event-stream(?:;|$)/iu.test(
      input.headers["content-type"] ?? ""
    )
  ) {
    throw new Error("provider_sse_invalid");
  }
  return new OpenAICompatibleSseDecoder(input);
}

class OpenAICompatibleSseDecoder implements ProviderSseStreamDecoder {
  readonly partial: AssistantMessage;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private receivedBytes = 0;
  private finishReason = "";
  private finished = false;
  private activeThinkingIndex: number | null = null;
  private activeTextIndex: number | null = null;
  private readonly toolCalls = new Map<number, {
    contentIndex: number;
    toolCall: ToolCall;
    argumentsText: string;
    ended: boolean;
  }>();

  constructor(private readonly input: {
    stream: AssistantMessageEventStream;
    model: Model<Api>;
    timestamp: number;
  }) {
    this.partial = {
      role: "assistant",
      content: [],
      api: input.model.api,
      provider: input.model.provider,
      model: input.model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: input.timestamp
    };
    input.stream.push({ type: "start", partial: this.partial });
  }

  push(chunk: Uint8Array | string): void {
    if (this.finished) throw new Error("provider_sse_already_finished");
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk, "utf8")
      : chunk;
    this.receivedBytes += bytes.byteLength;
    if (this.receivedBytes > MAX_RESPONSE_BYTES) {
      throw new Error("provider_sse_response_too_large");
    }
    try {
      this.buffer += this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new Error("provider_utf8_invalid");
    }
    this.drainEvents();
  }

  finish(): AssistantMessage {
    if (this.finished) throw new Error("provider_sse_already_finished");
    this.finished = true;
    try {
      this.buffer += this.decoder.decode();
    } catch {
      throw new Error("provider_utf8_invalid");
    }
    this.drainEvents();
    if (this.buffer.trim()) {
      const finalBlock = this.buffer;
      this.buffer = "";
      this.consumeBlock(finalBlock);
    }
    this.endThinking();
    this.endText();
    if (!this.finishReason) throw new Error("provider_finish_reason_missing");
    if (this.finishReason === "content_filter") {
      throw new Error("provider_content_filtered");
    }
    if (this.finishReason === "network_error") {
      throw new Error("provider_network_error");
    }
    if (this.finishReason === "length") {
      // Even calls whose JSON happens to parse may have been cut short. Keep
      // the response body, but leave all continuation to the outer runtime.
      this.discardToolCalls();
      this.partial.stopReason = "length";
    } else if (
      this.finishReason === "tool_calls"
      || this.finishReason === "function_call"
    ) {
      if (!this.partial.content.some((block) => block.type === "toolCall")) {
        throw new Error("provider_tool_call_missing");
      }
      this.endToolCalls();
      this.partial.stopReason = "toolUse";
    } else if (
      this.finishReason === "stop"
      || this.finishReason === "end"
    ) {
      this.discardToolCalls();
      this.partial.stopReason = "stop";
    } else {
      throw new Error("provider_finish_reason_unsupported");
    }
    deepFreeze(this.partial);
    this.input.stream.push({
      type: "done",
      reason: this.partial.stopReason,
      message: this.partial
    });
    return this.partial;
  }

  private drainEvents(): void {
    while (true) {
      const boundary = nextSseEventBoundary(this.buffer);
      if (!boundary) return;
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.consumeBlock(block);
    }
  }

  private consumeBlock(block: string): void {
    const data = block
      .split(/\r\n|\r|\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = parseRecord(data);
    } catch {
      throw new Error("provider_sse_json_invalid");
    }
    if (typeof chunk.id === "string" && chunk.id) {
      this.partial.responseId ??= chunk.id;
    }
    if (typeof chunk.model === "string" && chunk.model) {
      this.partial.responseModel ??= chunk.model;
    }
    if (isPlainRecord(chunk.usage)) {
      this.partial.usage = parseUsage(chunk.usage);
    }
    const choice: unknown = Array.isArray(chunk.choices)
      ? (chunk.choices as unknown[])[0]
      : null;
    if (!isPlainRecord(choice)) return;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }
    if (!isPlainRecord(choice.delta)) return;
    for (const field of [
      "reasoning_content",
      "reasoning",
      "reasoning_text"
    ] as const) {
      const value = choice.delta[field];
      if (typeof value === "string" && value.length > 0) {
        this.appendThinking(value);
        break;
      }
    }
    if (typeof choice.delta.content === "string" && choice.delta.content) {
      this.appendText(choice.delta.content);
    }
    if (Array.isArray(choice.delta.tool_calls)) {
      for (const candidate of choice.delta.tool_calls) {
        this.appendToolCall(candidate);
      }
    }
  }

  private appendThinking(delta: string): void {
    this.endText();
    if (this.toolCalls.size > 0) this.endToolCalls();
    if (this.activeThinkingIndex === null) {
      const contentIndex = this.partial.content.length;
      this.partial.content.push({ type: "thinking", thinking: "" });
      this.activeThinkingIndex = contentIndex;
      this.input.stream.push({
        type: "thinking_start",
        contentIndex,
        partial: this.partial
      });
    }
    const contentIndex = this.activeThinkingIndex;
    const content = this.partial.content[contentIndex];
    if (!content || content.type !== "thinking") {
      throw new Error("provider_reasoning_state_invalid");
    }
    content.thinking += delta;
    this.input.stream.push({
      type: "thinking_delta",
      contentIndex,
      delta,
      partial: this.partial
    });
  }

  private appendText(delta: string): void {
    this.endThinking();
    if (this.toolCalls.size > 0) this.endToolCalls();
    if (this.activeTextIndex === null) {
      const contentIndex = this.partial.content.length;
      this.partial.content.push({ type: "text", text: "" });
      this.activeTextIndex = contentIndex;
      this.input.stream.push({
        type: "text_start",
        contentIndex,
        partial: this.partial
      });
    }
    const contentIndex = this.activeTextIndex;
    const content = this.partial.content[contentIndex];
    if (!content || content.type !== "text") {
      throw new Error("provider_text_state_invalid");
    }
    content.text += delta;
    this.input.stream.push({
      type: "text_delta",
      contentIndex,
      delta,
      partial: this.partial
    });
  }

  private appendToolCall(value: unknown): void {
    this.endThinking();
    this.endText();
    if (
      !isPlainRecord(value)
      || !Number.isSafeInteger(value.index)
      || Number(value.index) < 0
      || Number(value.index) > 128
    ) {
      throw new Error("provider_tool_delta_invalid");
    }
    const index = Number(value.index);
    let state = this.toolCalls.get(index);
    if (!state) {
      const toolCall: ToolCall = {
        type: "toolCall",
        id: "",
        name: "",
        arguments: {}
      };
      const contentIndex = this.partial.content.length;
      this.partial.content.push(toolCall);
      state = { contentIndex, toolCall, argumentsText: "", ended: false };
      this.toolCalls.set(index, state);
      this.input.stream.push({
        type: "toolcall_start",
        contentIndex,
        partial: this.partial
      });
    }
    if (state.ended) throw new Error("provider_tool_delta_invalid");
    if (typeof value.id === "string" && value.id) state.toolCall.id = value.id;
    if (!isPlainRecord(value.function)) return;
    if (typeof value.function.name === "string" && value.function.name) {
      state.toolCall.name += value.function.name;
    }
    const delta = typeof value.function.arguments === "string"
      ? value.function.arguments
      : "";
    if (delta) {
      state.argumentsText += delta;
      state.toolCall.arguments = parseStreamingJson(state.argumentsText);
      this.input.stream.push({
        type: "toolcall_delta",
        contentIndex: state.contentIndex,
        delta,
        partial: this.partial
      });
    }
    if (
      state.toolCall.id.length > 256
      || state.toolCall.name.length > 256
      || state.argumentsText.length > 1_000_000
    ) {
      throw new Error("provider_tool_delta_invalid");
    }
  }

  private endThinking(): void {
    if (this.activeThinkingIndex === null) return;
    const contentIndex = this.activeThinkingIndex;
    this.activeThinkingIndex = null;
    const content = this.partial.content[contentIndex];
    if (!content || content.type !== "thinking") {
      throw new Error("provider_reasoning_state_invalid");
    }
    this.input.stream.push({
      type: "thinking_end",
      contentIndex,
      content: content.thinking,
      partial: this.partial
    });
  }

  private endText(): void {
    if (this.activeTextIndex === null) return;
    const contentIndex = this.activeTextIndex;
    this.activeTextIndex = null;
    const content = this.partial.content[contentIndex];
    if (!content || content.type !== "text") {
      throw new Error("provider_text_state_invalid");
    }
    this.input.stream.push({
      type: "text_end",
      contentIndex,
      content: content.text,
      partial: this.partial
    });
  }

  private endToolCalls(): void {
    for (const [, state] of [...this.toolCalls].sort(
      ([left], [right]) => left - right
    )) {
      if (state.ended) continue;
      if (!state.toolCall.id || !state.toolCall.name) {
        throw new Error("provider_tool_delta_invalid");
      }
      state.toolCall.arguments = parseRecord(state.argumentsText || "{}");
      state.ended = true;
      this.input.stream.push({
        type: "toolcall_end",
        contentIndex: state.contentIndex,
        toolCall: state.toolCall,
        partial: this.partial
      });
    }
    this.toolCalls.clear();
  }

  private discardToolCalls(): void {
    this.partial.content = this.partial.content.filter(
      (block) => block.type !== "toolCall"
    );
    this.toolCalls.clear();
  }
}

function nextSseEventBoundary(
  value: string
): { index: number; length: number } | null {
  const match = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/u.exec(value);
  return match?.index === undefined
    ? null
    : { index: match.index, length: match[0].length };
}

export function buildDeepSeekBody(
  input: ControlledPiStreamInput
): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: input.provider.modelRef,
    messages: contextMessages(input.context, input.model),
    stream: true,
    temperature: input.options.temperature,
    max_tokens: input.options.maxTokens
  };
  if (input.context.tools?.length) {
    body.tools = input.context.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters)
      }
    }));
  }
  applyProviderReasoningOptions(body, input);
  return deepFreeze(body);
}

/**
 * Qwen Token Plan uses the OpenAI Chat surface but cannot be reached through
 * the renderer's browser fetch because its endpoint rejects CORS preflight.
 * Keep this payload aligned with Pi's Qwen compatibility contract while the
 * transport is provided by the Obsidian desktop runtime.
 */
export function buildQwenTokenPlanBody(
  input: ControlledPiStreamInput
): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: input.provider.modelRef,
    messages: contextMessages(input.context, input.model),
    stream: true,
    stream_options: { include_usage: true },
    temperature: input.options.temperature
  };
  if (input.options.maxTokens !== undefined) {
    body.max_tokens = input.options.maxTokens;
  }
  if (input.context.tools?.length) {
    body.tools = input.context.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters)
      }
    }));
  }
  applyProviderReasoningOptions(body, input);
  return deepFreeze(body);
}

function applyProviderReasoningOptions(
  body: Record<string, unknown>,
  input: ControlledPiStreamInput
): void {
  if (
    input.model.api !== "openai-completions"
    || !input.model.reasoning
  ) return;
  const model = input.model as Model<"openai-completions">;
  const level = input.options.reasoning;
  const wireLevel: string | undefined = level;
  const enabled = Boolean(wireLevel && wireLevel !== "off");
  const mapped = enabled && level
    ? model.thinkingLevelMap?.[level]
    : undefined;
  const effort = mapped === null
    ? undefined
    : mapped ?? (enabled ? level : undefined);
  const format = model.compat?.thinkingFormat;
  if (format === "deepseek") {
    body.thinking = { type: effort ? "enabled" : "disabled" };
  } else if (format === "qwen") {
    body.enable_thinking = Boolean(effort);
    return;
  }
  if (
    effort
    && model.compat?.supportsReasoningEffort !== false
  ) {
    body.reasoning_effort = effort;
  } else if (!effort) {
    const off = model.thinkingLevelMap?.off;
    if (typeof off === "string") body.reasoning_effort = off;
  }
}

function contextMessages(context: Context, model: Model<Api>): unknown[] {
  const result: unknown[] = [];
  if (typeof context.systemPrompt === "string" && context.systemPrompt) {
    result.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of validProviderHistory(context.messages, model)) {
    result.push(...toOpenAICompatibleMessages(message));
  }
  return result;
}

export function validProviderHistory(
  messages: readonly Message[],
  model: Model<Api>
): Message[] {
  // Sanitize before Pi transforms cross-model thinking into text and inserts
  // synthetic results. Neither is valid for a truncated assistant response.
  const history = messages.flatMap((message): Message[] => {
    if (message.role !== "assistant" || message.stopReason !== "length") {
      return [message];
    }
    const content: TextContent[] = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => ({ type: "text", text: block.text }));
    return content.length ? [{ ...message, content }] : [];
  });
  const transformed = transformMessages(history, model);
  let pendingToolCallIds = new Set<string>();
  return transformed.filter((message) => {
    if (message.role === "assistant") {
      pendingToolCallIds = new Set(message.content
        .filter((block): block is ToolCall => block.type === "toolCall")
        .map((block) => block.id));
      return true;
    }
    if (message.role === "toolResult") {
      if (!pendingToolCallIds.has(message.toolCallId)) return false;
      pendingToolCallIds.delete(message.toolCallId);
      return true;
    }
    pendingToolCallIds.clear();
    return true;
  });
}

function toOpenAICompatibleMessages(message: Message): unknown[] {
  if (message.role === "user") {
    return [{
      role: "user",
      content: openAICompatibleContent(message.content)
    }];
  }
  if (message.role === "toolResult") {
    const content = openAICompatibleContent(message.content);
    if (typeof content === "string") {
      return [{
        role: "tool",
        tool_call_id: message.toolCallId,
        content
      }];
    }
    const text = content
      .filter((entry): entry is { type: "text"; text: string } =>
        entry.type === "text"
      )
      .map((entry) => entry.text)
      .join("\n");
    const images = content.filter((entry) => entry.type === "image_url");
    return [{
      role: "tool",
      tool_call_id: message.toolCallId,
      content: text || (images.length ? "(see attached image)" : "")
    }, ...(images.length
      ? [{
        role: "user",
        content: [{
          type: "text",
          text: "Attached image(s) from tool result:"
        }, ...images]
      }]
      : [])];
  }
  const text = message.content
    .filter((entry): entry is TextContent => entry.type === "text")
    .map((entry) => entry.text)
    .join("");
  const reasoning = message.content
    .filter((entry): entry is ThinkingContent =>
      entry.type === "thinking" && entry.redacted !== true
    )
    .map((entry) => entry.thinking)
    .join("\n");
  const toolCalls = message.content
    .filter((entry): entry is ToolCall => entry.type === "toolCall")
    .map((entry) => ({
      id: entry.id,
      type: "function",
      function: {
        name: entry.name,
        arguments: JSON.stringify(entry.arguments)
      }
    }));
  return [{
    role: "assistant",
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  }];
}

type OpenAICompatibleContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
>;

function openAICompatibleContent(content: unknown): OpenAICompatibleContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new Error("provider_message_content_invalid");
  }
  const parts: Exclude<OpenAICompatibleContent, string> = [];
  for (const entry of content as unknown[]) {
    if (!isPlainRecord(entry)) {
      throw new Error("provider_message_content_invalid");
    }
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push({ type: "text", text: entry.text });
      continue;
    }
    if (entry.type === "image") {
      const image = entry as unknown as ImageContent;
      if (
        typeof image.data !== "string"
        || !/^image\/[A-Za-z0-9.+-]+$/u.test(image.mimeType)
      ) {
        throw new Error("provider_image_content_invalid");
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${image.mimeType};base64,${image.data}`
        }
      });
      continue;
    }
    throw new Error("provider_message_content_invalid");
  }
  return parts;
}

export function parseDeepSeekSseResponse(
  response: ProviderSseResponse,
  model: Model<Api>,
  timestamp: number
): AssistantMessage {
  if (
    !Number.isFinite(timestamp)
    || !/^text\/event-stream(?:;|$)/iu.test(
      response.headers["content-type"] ?? ""
    )
    || Buffer.byteLength(response.body, "utf8") > MAX_RESPONSE_BYTES
  ) {
    throw new Error("deepseek_sse_invalid");
  }
  let text = "";
  let reasoning = "";
  let finishReason = "";
  let responseId: string | undefined;
  let responseModel: string | undefined;
  let usage = emptyUsage();
  const toolCalls = new Map<number, {
    id: string;
    name: string;
    argumentsText: string;
  }>();

  const blocks = response.body
    .replace(/\r\n?/gu, "\n")
    .split("\n\n");
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      continue;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = parseRecord(data);
    } catch {
      throw new Error("provider_sse_json_invalid");
    }
    if (typeof chunk.id === "string" && chunk.id) responseId ??= chunk.id;
    if (typeof chunk.model === "string" && chunk.model) {
      responseModel ??= chunk.model;
    }
    if (isPlainRecord(chunk.usage)) usage = parseUsage(chunk.usage);
    const choice: unknown = Array.isArray(chunk.choices)
      ? (chunk.choices as unknown[])[0]
      : null;
    if (!isPlainRecord(choice)) continue;
    if (typeof choice.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }
    if (!isPlainRecord(choice.delta)) continue;
    if (typeof choice.delta.content === "string") {
      text += choice.delta.content;
    }
    for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
      const value = choice.delta[field];
      if (typeof value === "string" && value.length > 0) {
        reasoning += value;
        break;
      }
    }
    if (Array.isArray(choice.delta.tool_calls)) {
      for (const candidate of choice.delta.tool_calls) {
        appendToolCallDelta(toolCalls, candidate);
      }
    }
  }
  if (!finishReason) throw new Error("provider_finish_reason_missing");
  if (finishReason === "length") {
    throw new Error("provider_output_limit_reached");
  }
  if (finishReason === "content_filter") {
    throw new Error("provider_content_filtered");
  }
  if (finishReason === "network_error") {
    throw new Error("provider_network_error");
  }
  const toolUse = finishReason === "tool_calls"
    || finishReason === "function_call";
  if (
    !toolUse
    && finishReason !== "stop"
    && finishReason !== "end"
  ) {
    throw new Error("provider_finish_reason_unsupported");
  }
  if (toolUse && toolCalls.size === 0) {
    throw new Error("provider_tool_call_missing");
  }

  const content: Array<TextContent | ThinkingContent | ToolCall> = [];
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  if (text) content.push({ type: "text", text });
  if (toolUse) {
    for (const [, tool] of [...toolCalls.entries()].sort(
      ([left], [right]) => left - right
    )) {
      content.push({
        type: "toolCall",
        id: tool.id,
        name: tool.name,
        arguments: parseRecord(tool.argumentsText || "{}")
      });
    }
  }
  const stopReason = toolUse ? "toolUse" as const : "stop" as const;
  return deepFreeze({
    role: "assistant" as const,
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    ...(responseModel ? { responseModel } : {}),
    ...(responseId ? { responseId } : {}),
    usage,
    stopReason,
    timestamp
  });
}

function appendToolCallDelta(
  tools: Map<number, { id: string; name: string; argumentsText: string }>,
  value: unknown
): void {
  if (
    !isPlainRecord(value)
    || !Number.isSafeInteger(value.index)
    || Number(value.index) < 0
    || Number(value.index) > 128
  ) {
    throw new Error("deepseek_tool_delta_invalid");
  }
  const index = Number(value.index);
  const current = tools.get(index) ?? { id: "", name: "", argumentsText: "" };
  if (typeof value.id === "string" && value.id) current.id = value.id;
  if (isPlainRecord(value.function)) {
    if (typeof value.function.name === "string" && value.function.name) {
      current.name += value.function.name;
    }
    if (typeof value.function.arguments === "string") {
      current.argumentsText += value.function.arguments;
    }
  }
  if (
    current.id.length > 256
    || current.name.length > 256
    || current.argumentsText.length > 1_000_000
  ) {
    throw new Error("deepseek_tool_delta_invalid");
  }
  tools.set(index, current);
}

export function emitBufferedMessage(
  stream: AssistantMessageEventStream,
  message: AssistantMessage
): void {
  const empty = structuredClone({ ...message, content: [] });
  stream.push({ type: "start", partial: empty });
  for (let index = 0; index < message.content.length; index += 1) {
    const content = message.content[index];
    const partial = structuredClone(message);
    if (content.type === "text") {
      stream.push({ type: "text_start", contentIndex: index, partial });
      stream.push({
        type: "text_delta",
        contentIndex: index,
        delta: content.text,
        partial
      });
      stream.push({
        type: "text_end",
        contentIndex: index,
        content: content.text,
        partial
      });
    } else if (content.type === "thinking") {
      stream.push({ type: "thinking_start", contentIndex: index, partial });
      stream.push({
        type: "thinking_delta",
        contentIndex: index,
        delta: content.thinking,
        partial
      });
      stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: content.thinking,
        partial
      });
    } else if (content.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex: index, partial });
      stream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: JSON.stringify(content.arguments),
        partial
      });
      stream.push({
        type: "toolcall_end",
        contentIndex: index,
        toolCall: content,
        partial
      });
    }
  }
  stream.push({
    type: "done",
    reason: message.stopReason as "stop" | "length" | "toolUse",
    message
  });
}

function parseUsage(value: Record<string, unknown>): Usage {
  const input = nonNegativeInteger(value.prompt_tokens);
  const output = nonNegativeInteger(value.completion_tokens);
  const total = nonNegativeInteger(value.total_tokens);
  if (total < input + output) throw new Error("deepseek_usage_invalid");
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("deepseek_usage_invalid");
  }
  return Number(value);
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isPlainRecord(parsed)) throw new Error("deepseek_json_invalid");
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
