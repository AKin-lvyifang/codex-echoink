import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

/** A single local reference vocabulary, independent of the selected Provider. */
export const USAGE_TOKEN_STANDARD = "echoink-o200k-v1" as const;
export const ESTIMATED_IMAGE_TOKENS = 1_200;
let tokenizer: Tiktoken | undefined;
// Adjacent requests reuse system prompts, schemas and history. Keep only a
// small in-memory working set; no prompt or response text is persisted.
const recentCounts = new Map<string, number>();
let cachedCharacters = 0;

export function countTextTokens(text: string): number {
  if (!text) return 0;
  const cached = recentCounts.get(text);
  if (cached !== undefined) {
    recentCounts.delete(text);
    recentCounts.set(text, cached);
    return cached;
  }
  tokenizer ??= new Tiktoken(o200kBase);
  // Treat special-token-looking text as ordinary user content.
  const count = tokenizer.encode(text, [], []).length;
  if (text.length <= 50_000) {
    recentCounts.set(text, count);
    cachedCharacters += text.length;
    while (recentCounts.size > 64 || cachedCharacters > 200_000) {
      const oldest = recentCounts.keys().next();
      if (oldest.done) break;
      recentCounts.delete(oldest.value);
      cachedCharacters -= oldest.value.length;
    }
  }
  return count;
}

/** Count inference content, never Pi bookkeeping, signatures, or image bytes. */
export function estimateTokenValue(value: unknown): number {
  if (record(value) && Array.isArray(value.messages)) {
    return estimateUsageInputTokens(value as unknown as Context);
  }
  const normalized = normalizeValue(value);
  return countTextTokens(typeof normalized.value === "string"
    ? normalized.value
    : JSON.stringify(normalized.value) ?? "")
    + normalized.images * ESTIMATED_IMAGE_TOKENS;
}

export function estimateUsageInputTokens(context: Readonly<Context>): number {
  return estimateTokenValue(context.systemPrompt ?? "")
    + (context.tools ?? []).reduce((total, tool) => total + estimateTokenValue(tool), 0)
    + context.messages.reduce((total, message) => total + estimateTokenValue(message), 0);
}

/** Includes returned reasoning text and tool arguments, never hidden reasoning. */
export function estimateUsageOutputTokens(message: Pick<AssistantMessage, "content">): number {
  return message.content.reduce((total, block) => {
    if (block.type === "text") return total + countTextTokens(block.text);
    if (block.type === "thinking") return total + countTextTokens(block.thinking);
    if (block.type === "toolCall") {
      return total + estimateTokenValue({ name: block.name, arguments: block.arguments });
    }
    return total;
  }, 0);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeValue(value: unknown): { value: unknown; images: number } {
  let images = 0;
  const content = (blocks: unknown): unknown => {
    if (typeof blocks === "string") return blocks;
    if (!Array.isArray(blocks)) return [];
    return blocks.flatMap((block): unknown[] => {
      if (!record(block)) return [];
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type === "thinking") {
        return typeof block.thinking === "string" && block.thinking
          ? [{ type: "thinking", thinking: block.thinking }]
          : [];
      }
      if (block.type === "toolCall") {
        return [{ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }];
      }
      if (block.type === "image") {
        images += 1;
        return [{ type: "image" }];
      }
      return [];
    });
  };
  let normalized = value;
  if (Array.isArray(value)) {
    normalized = value.map(piece => {
      const item = normalizeValue(piece);
      images += item.images;
      return item.value;
    });
  } else if (record(value)) {
    if (["user", "assistant", "toolResult"].includes(String(value.role)) && "content" in value) {
      normalized = {
        role: value.role,
        content: content(value.content),
        ...(value.role === "toolResult" ? { toolCallId: value.toolCallId, toolName: value.toolName } : {})
      };
    } else if (typeof value.name === "string" && "parameters" in value) {
      normalized = { name: value.name, description: value.description, parameters: value.parameters };
    } else if (Array.isArray(value.messages)) {
      // This entry point is also used by context-budget admission checks.
      const tools: readonly unknown[] = Array.isArray(value.tools) ? value.tools : [];
      const messages: readonly unknown[] = value.messages;
      const pieces = [value.systemPrompt ?? "", ...tools, ...messages];
      return { value: pieces.map(piece => {
        const item = normalizeValue(piece);
        images += item.images;
        return item.value;
      }), images };
    }
  }
  return { value: normalized, images };
}
