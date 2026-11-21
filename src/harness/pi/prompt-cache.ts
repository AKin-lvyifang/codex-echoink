import { sha256Hex } from "../../utils/sha256";

const BOUNDARY = "\n\n<echoink_request_context>\n";
export function appendRequestContext(stable: string, dynamic: string): string {
  return stable + BOUNDARY + dynamic;
}
const CACHE_CONTROL = { type: "ephemeral" };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const split = (value: string): [string, string] | null => {
  const index = value.indexOf(BOUNDARY);
  return index < 0 ? null : [value.slice(0, index), value.slice(index + BOUNDARY.length)];
};
export function providerCacheKey(conversationId: string): string {
  return sha256Hex(JSON.stringify(["echoink-conversation", conversationId]));
}

export function anthropicCacheRoute(provider: string, model: string, protocol: string): boolean {
  return protocol === "anthropic-messages"
    || protocol === "openai-completions" && provider === "xiaoecho" && /^claude-/iu.test(model);
}

/** Keep the stable instruction block distinct before applying a provider cache marker. */
export function applyPromptCacheBoundary(payload: unknown, anthropic: boolean): unknown {
  if (!record(payload)) return payload;
  if (Array.isArray(payload.system)) {
    const blocks = (payload.system as unknown[]).flatMap(block => {
      if (!record(block) || typeof block.text !== "string") return [block];
      const parts = split(block.text);
      if (!parts) return [block];
      return [{ type: "text", text: parts[0], ...(anthropic ? { cache_control: CACHE_CONTROL } : {}) }, { type: "text", text: parts[1] }];
    });
    return { ...payload, system: blocks };
  }
  if (Array.isArray(payload.messages)) {
    const messages = (payload.messages as unknown[]).flatMap(message => {
      if (!record(message) || !["system", "developer"].includes(String(message.role)) || typeof message.content !== "string") return [message];
      const parts = split(message.content);
      if (!parts) return [message];
      return anthropic
        ? [{ ...message, content: [{ type: "text", text: parts[0], cache_control: CACHE_CONTROL }, { type: "text", text: parts[1] }] }]
        : [{ ...message, content: parts.join("\n\n") }];
    });
    return { ...payload, messages };
  }
  if (typeof payload.instructions === "string" && Array.isArray(payload.input)) {
    const parts = split(payload.instructions);
    if (parts) return { ...payload, instructions: parts.join("\n\n") };
  }
  return payload;
}

export function stableToolOrder<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
