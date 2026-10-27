import { searchTavily, tavilyErrorMessage, TavilyError, type TavilyTransport, type WebSearchResult } from "./tavily-search";
import { searchDeepSeek, DeepSeekSearchError, deepSeekSearchErrorMessage } from "./deepseek-search";
import { webSearchApiKey, webSearchProvider, type WebSearchSettings } from "./web-search-settings";
export * from "./web-search-settings";
export type { WebSearchResult, TavilyTransport as WebSearchTransport } from "./tavily-search";
export type WebSearchResponse = { source: "web"; provider: "Tavily" | "DeepSeek"; results: WebSearchResult[] };
export type WebSearchInput = { apiKey: string; query: string; maxResults?: number; signal?: AbortSignal; transport?: TavilyTransport; timeoutMs?: number };
export function webSearchQueryLimit(settings: WebSearchSettings): number { return webSearchProvider(settings) === "deepseek" ? 128 : 1_000; }
export function webSearchErrorMessage(error: unknown, english: boolean): string { return error instanceof DeepSeekSearchError ? deepSeekSearchErrorMessage(error, english) : tavilyErrorMessage(error, english); }
export function webSearchErrorCode(error: unknown): string { return error instanceof DeepSeekSearchError || error instanceof TavilyError ? error.message : "web_search_unavailable"; }
export async function searchWeb(settings: WebSearchSettings, input: Omit<WebSearchInput, "apiKey">): Promise<WebSearchResponse> {
  const response = await (webSearchProvider(settings) === "deepseek" ? searchDeepSeek : searchTavily)({ ...input, apiKey: webSearchApiKey(settings) });
  // Keep both saved credentials out of model/UI output, including provider echoes.
  const secrets = [settings.apiKey.trim(), settings.deepseekApiKey?.trim()].filter((key): key is string => Boolean(key)).sort((a, b) => b.length - a.length);
  const clean = (text: string) => secrets.reduce((value, key) => value.split(key).join("[redacted]"), text);
  return { ...response, results: response.results.map(row => ({ title: clean(row.title), url: clean(row.url), summary: clean(row.summary), ...(row.publishedDate !== undefined ? { publishedDate: clean(row.publishedDate) } : {}) })) };
}
