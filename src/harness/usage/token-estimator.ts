import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { usageTokenWorkerSource } from "./token-worker-source";

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
  cacheCount(text, count);
  return count;
}

function cacheCount(text: string, count: number): void {
  if (text.length <= 50_000 && !recentCounts.has(text)) {
    recentCounts.set(text, count);
    cachedCharacters += text.length;
    while (recentCounts.size > 64 || cachedCharacters > 200_000) {
      const oldest = recentCounts.keys().next();
      if (oldest.done) break;
      recentCounts.delete(oldest.value);
      cachedCharacters -= oldest.value.length;
    }
  }
}

let countingWorker: Worker | undefined;
let workerSequence = 0;
const pendingCounts = new Map<number, { resolve(count: number): void; reject(error: Error): void }>();
const countingTexts = new Map<string, Promise<number>>();
let workerIdle: number | undefined;

function releaseIdleWorker(): void {
  if (workerIdle !== undefined) window.clearTimeout(workerIdle);
  workerIdle = window.setTimeout(() => {
    workerIdle = undefined;
    if (!pendingCounts.size) { countingWorker?.terminate(); countingWorker = undefined; }
  }, 30_000);
}

/** Same vocabulary and special-token treatment; only the thread changes. */
export async function countTextTokensAsync(text: string): Promise<number> {
  if (!text) return 0;
  const cached = recentCounts.get(text); if (cached !== undefined) return cached;
  if (!usageTokenWorkerSource || typeof Worker === "undefined") return countTextTokens(text);
  const existing = countingTexts.get(text); if (existing) return existing;
  if (workerIdle !== undefined) { window.clearTimeout(workerIdle); workerIdle = undefined; }
  if (!countingWorker) {
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([usageTokenWorkerSource], { type: "text/javascript" }));
      const worker = countingWorker = new Worker(url);
      const failed = () => {
        if (countingWorker !== worker) return;
        countingWorker = undefined; worker.terminate();
        for (const pending of pendingCounts.values()) pending.reject(new Error("token_worker_failed"));
        pendingCounts.clear();
      };
      worker.onmessage = (event: MessageEvent<{ id: number; count: number; error?: string }>) => {
        if (countingWorker !== worker) return;
        const { id, count, error } = event.data;
        const pending = pendingCounts.get(id); pendingCounts.delete(id);
        if (error || !Number.isSafeInteger(count) || count < 0) { pending?.reject(new Error("token_worker_failed")); failed(); }
        else pending?.resolve(count);
        if (!pendingCounts.size) releaseIdleWorker();
      };
      worker.onerror = failed;
      worker.postMessage({ ranks: o200kBase });
    } catch { countingWorker?.terminate(); countingWorker = undefined; return countTextTokens(text); }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  const worker = countingWorker;
  const result = new Promise<number>((resolve, reject) => {
    const id = ++workerSequence; pendingCounts.set(id, { resolve, reject });
    try { worker.postMessage({ id, text }); } catch (error) { pendingCounts.delete(id); reject(error instanceof Error ? error : new Error("token_worker_failed")); if (!pendingCounts.size) releaseIdleWorker(); }
  }).catch(() => countTextTokens(text)).then(count => { cacheCount(text, count); return count; }).finally(() => countingTexts.delete(text));
  countingTexts.set(text, result);
  return result;
}

export function disposeUsageTokenWorker(): void {
  if (workerIdle !== undefined) { window.clearTimeout(workerIdle); workerIdle = undefined; }
  countingWorker?.terminate(); countingWorker = undefined;
  for (const pending of pendingCounts.values()) pending.reject(new Error("token_worker_disposed"));
  pendingCounts.clear(); recentCounts.clear(); cachedCharacters = 0;
}

/** Ephemeral request-local identity after stripping non-inference bookkeeping. */
export function tokenEstimateKey(value: unknown): string { return JSON.stringify(normalizeValue(value)); }

export async function estimateTokenValueAsync(value: unknown): Promise<number> {
  if (record(value) && Array.isArray(value.messages)) return estimateUsageInputTokensAsync(value as unknown as Context);
  const normalized = normalizeValue(value);
  return await countTextTokensAsync(typeof normalized.value === "string" ? normalized.value : JSON.stringify(normalized.value) ?? "")
    + normalized.images * ESTIMATED_IMAGE_TOKENS;
}

export async function estimateUsageInputTokensAsync(context: Readonly<Context>): Promise<number> {
  const counts = await Promise.all([context.systemPrompt ?? "", ...(context.tools ?? []), ...context.messages].map(estimateTokenValueAsync));
  return counts.reduce((sum, count) => sum + count, 0);
}

export async function estimateUsageOutputTokensAsync(message: Pick<AssistantMessage, "content">): Promise<number> {
  const counts = await Promise.all(message.content.map(block => block.type === "text" ? countTextTokensAsync(block.text)
    : block.type === "thinking" ? countTextTokensAsync(block.thinking)
    : block.type === "toolCall" ? estimateTokenValueAsync({ name: block.name, arguments: block.arguments }) : Promise.resolve(0)));
  return counts.reduce((sum, count) => sum + count, 0);
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
