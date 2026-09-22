import { requestUrl } from "obsidian";

export interface TavilySettings { enabled: boolean; apiKey: string }
export interface WebSearchResult { title: string; url: string; summary: string; publishedDate?: string }
export type TavilyErrorCode = "key_missing" | "key_invalid" | "quota" | "rate_limit" | "network" | "timeout" | "cancelled" | "invalid_response";
export class TavilyError extends Error {
  constructor(readonly code: TavilyErrorCode) { super(`tavily_${code}`); }
}
export type TavilyTransport = (request: { url: string; method: string; headers: Record<string, string>; body: string; throw: boolean }) => Promise<{ status: number; json: unknown }>;
export function tavilyAvailable(settings: TavilySettings): boolean { return settings.enabled && Boolean(settings.apiKey.trim()); }
export function normalizeTavilySettings(value: unknown): TavilySettings {
  const record = value && typeof value === "object" ? value as Partial<TavilySettings> : {};
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  return { enabled: record.enabled === true && Boolean(apiKey), apiKey };
}

/** Obsidian's cross-platform transport avoids browser CORS and never logs credentials. */
export async function searchTavily(input: {
  apiKey: string; query: string; maxResults?: number; signal?: AbortSignal;
  transport?: TavilyTransport; timeoutMs?: number;
}): Promise<{ source: "web"; provider: "Tavily"; results: WebSearchResult[] }> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new TavilyError("key_missing");
  if (input.signal?.aborted) throw new TavilyError("cancelled");
  const query = input.query.trim();
  if (!query || query.length > 1_000) throw new TavilyError("invalid_response");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TavilyError("timeout")), input.timeoutMs ?? 20_000);
      cancel = () => reject(new TavilyError("cancelled"));
      input.signal?.addEventListener("abort", cancel, { once: true });
    });
    const response = await Promise.race([(input.transport ?? requestUrl)({
      url: "https://api.tavily.com/search", method: "POST", throw: false,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, search_depth: "basic", auto_parameters: false,
        max_results: Math.max(1, Math.min(5, input.maxResults ?? 5)), include_answer: false, include_raw_content: false })
    }), interrupted]);
    if ([401, 403].includes(response.status)) throw new TavilyError("key_invalid");
    if ([402, 432, 433].includes(response.status)) throw new TavilyError("quota");
    if (response.status === 429) throw new TavilyError("rate_limit");
    if (response.status < 200 || response.status >= 300) throw new TavilyError("network");
    const body = response.json as { results?: unknown } | null;
    if (!body || !Array.isArray(body.results)) throw new TavilyError("invalid_response");
    const rows: unknown[] = body.results;
    const results: WebSearchResult[] = [];
    for (const value of rows.slice(0, input.maxResults ?? 5)) {
      if (!value || typeof value !== "object") throw new TavilyError("invalid_response");
      const row = value as Record<string, unknown>;
      if (typeof row.url !== "string" || typeof row.title !== "string" || typeof row.content !== "string") throw new TavilyError("invalid_response");
      let url: URL;
      try { url = new URL(row.url); } catch { throw new TavilyError("invalid_response"); }
      if (!["https:", "http:"].includes(url.protocol)) continue;
      // Neither upstream errors nor echoed credentials can reach UI/model output.
      const clean = (text: string) => text.split(apiKey).join("[redacted]");
      results.push({ title: clean(row.title).slice(0, 500), url: clean(url.href), summary: clean(row.content).slice(0, 3_000),
        ...(typeof row.published_date === "string" ? { publishedDate: clean(row.published_date).slice(0, 100) } : {}) });
    }
    return { source: "web", provider: "Tavily", results };
  } catch (error) { throw error instanceof TavilyError ? error : new TavilyError("network"); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel) input.signal?.removeEventListener("abort", cancel);
  }
}
export function tavilyErrorMessage(error: unknown, english: boolean): string {
  const messages: Record<TavilyErrorCode, [string, string]> = {
    key_missing: ["请先填写 API Key。", "Enter an API key first."],
    key_invalid: ["API Key 无效或无访问权限，请检查。", "The API key is invalid or lacks access."],
    quota: ["Tavily 积分不足，请检查账户额度。", "Tavily credits are exhausted. Check your account."],
    rate_limit: ["请求过于频繁，请稍后重试。", "Rate limited. Try again later."],
    network: ["连接失败，请检查网络后重试。", "Connection failed. Check your network and retry."],
    timeout: ["连接超时，请稍后重试。", "Connection timed out. Try again later."],
    cancelled: ["测试已取消。", "Test cancelled."],
    invalid_response: ["未收到有效的搜索响应。", "No valid search response received."]
  };
  return messages[error instanceof TavilyError ? error.code : "network"][english ? 1 : 0];
}
