import { requestUrl } from "obsidian";
import type { TavilyTransport, WebSearchResult } from "./tavily-search";

export type DeepSeekSearchErrorCode = "key_missing" | "key_invalid" | "quota" | "rate_limit" | "network" | "timeout" | "cancelled" | "invalid_response" | "invalid_query";
export class DeepSeekSearchError extends Error {
  constructor(readonly code: DeepSeekSearchErrorCode) { super(`deepseek_search_${code}`); }
}
/** Count Unicode code points, rather than UTF-16 code units; never shorten a query. */
export function validateDeepSeekSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed || Array.from(trimmed).length > 128) throw new DeepSeekSearchError("invalid_query");
  return trimmed;
}
export async function searchDeepSeek(input: { apiKey: string; query: string; maxResults?: number; signal?: AbortSignal; transport?: TavilyTransport; timeoutMs?: number }): Promise<{ source: "web"; provider: "DeepSeek"; results: WebSearchResult[] }> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new DeepSeekSearchError("key_missing");
  if (input.signal?.aborted) throw new DeepSeekSearchError("cancelled");
  const query = validateDeepSeekSearchQuery(input.query);
  const count = Number.isFinite(input.maxResults) ? Math.max(1, Math.min(5, Math.floor(input.maxResults!))) : 5;
  let timer: number | undefined, cancel: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new DeepSeekSearchError("timeout")), input.timeoutMs ?? 20_000);
      cancel = () => reject(new DeepSeekSearchError("cancelled")); input.signal?.addEventListener("abort", cancel, { once: true });
    });
    const response = await Promise.race([(input.transport ?? requestUrl)({ url: "https://api.deepseek.com/v1/tools/search", method: "POST", throw: false,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, count, need_content: false }) }), interrupted]);
    if ([401, 403].includes(response.status)) throw new DeepSeekSearchError("key_invalid");
    if (response.status === 402) throw new DeepSeekSearchError("quota");
    if (response.status === 429) throw new DeepSeekSearchError("rate_limit");
    if (response.status < 200 || response.status >= 300) throw new DeepSeekSearchError("network");
    const body = response.json as { results?: unknown } | null;
    if (!body || !Array.isArray(body.results)) throw new DeepSeekSearchError("invalid_response");
    const results: WebSearchResult[] = [], clean = (text: string) => text.split(apiKey).join("[redacted]");
    for (const value of body.results.slice(0, count)) {
      if (!value || typeof value !== "object") throw new DeepSeekSearchError("invalid_response");
      const row = value as Record<string, unknown>;
      const summary = typeof row.summary === "string" && row.summary.trim() ? row.summary : typeof row.snippet === "string" ? row.snippet : row.summary;
      if (typeof row.url !== "string" || typeof row.title !== "string" || typeof summary !== "string") throw new DeepSeekSearchError("invalid_response");
      let url: URL; try { url = new URL(row.url); } catch { throw new DeepSeekSearchError("invalid_response"); }
      if (!["https:", "http:"].includes(url.protocol)) continue;
      results.push({ title: clean(row.title).slice(0, 500), url: clean(url.href), summary: clean(summary).slice(0, 3_000),
        ...(typeof row.date === "string" ? { publishedDate: clean(row.date).slice(0, 100) } : {}) });
    }
    return { source: "web", provider: "DeepSeek", results };
  } catch (error) { throw error instanceof DeepSeekSearchError ? error : new DeepSeekSearchError("network"); }
  finally { if (timer !== undefined) window.clearTimeout(timer); if (cancel) input.signal?.removeEventListener("abort", cancel); }
}
export function deepSeekSearchErrorMessage(error: DeepSeekSearchError, english: boolean): string {
  const messages: Record<DeepSeekSearchErrorCode, [string, string]> = {
    key_missing: ["请先填写 API Key。", "Enter an API key first."], key_invalid: ["DeepSeek API Key 无效或无访问权限，请检查。", "The DeepSeek API key is invalid or lacks access."],
    quota: ["DeepSeek 余额不足，请检查账户余额。", "Your DeepSeek balance is insufficient. Check your account."],
    rate_limit: ["请求过于频繁，请稍后重试。", "Rate limited. Try again later."], network: ["连接失败，请检查网络后重试。", "Connection failed. Check your network and retry."],
    timeout: ["连接超时，请稍后重试。", "Connection timed out. Try again later."], cancelled: ["测试已取消。", "Test cancelled."],
    invalid_response: ["未收到有效的搜索响应。", "No valid search response received."],
    invalid_query: ["DeepSeek 搜索词须为 1–128 个 Unicode 字符，请缩短搜索词后重试。", "DeepSeek search queries must contain 1–128 Unicode characters. Shorten the query and retry."]
  };
  return messages[error.code][english ? 1 : 0];
}
