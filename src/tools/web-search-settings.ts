/** The legacy `tavily.apiKey` remains the Tavily key so upgrades preserve it. */
export type WebSearchProvider = "tavily" | "deepseek";
export interface WebSearchSettings {
  enabled: boolean;
  apiKey: string;
  provider?: WebSearchProvider;
  deepseekApiKey?: string;
}
export type NormalizedWebSearchSettings = Required<WebSearchSettings>;
export const WEB_SEARCH_PROVIDERS = ["tavily", "deepseek"] as const;
export function webSearchProvider(settings: WebSearchSettings): WebSearchProvider { return settings.provider === "deepseek" ? "deepseek" : "tavily"; }
export function webSearchProviderName(settings: WebSearchSettings): "Tavily" | "DeepSeek" { return webSearchProvider(settings) === "deepseek" ? "DeepSeek" : "Tavily"; }
export function webSearchApiKey(settings: WebSearchSettings): string { return (webSearchProvider(settings) === "deepseek" ? settings.deepseekApiKey ?? "" : settings.apiKey).trim(); }
export function setWebSearchApiKey(settings: WebSearchSettings, value: string): void {
  if (webSearchProvider(settings) === "deepseek") settings.deepseekApiKey = value.trim(); else settings.apiKey = value.trim();
}
export function webSearchAvailable(settings: WebSearchSettings): boolean { return settings.enabled && Boolean(webSearchApiKey(settings)); }
export function normalizeWebSearchSettings(value: unknown): NormalizedWebSearchSettings {
  const record = value && typeof value === "object" ? value as Partial<WebSearchSettings> : {};
  const normalized: NormalizedWebSearchSettings = { enabled: record.enabled === true, provider: record.provider === "deepseek" ? "deepseek" : "tavily",
    apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "", deepseekApiKey: typeof record.deepseekApiKey === "string" ? record.deepseekApiKey.trim() : "" };
  normalized.enabled = webSearchAvailable(normalized);
  return normalized;
}
