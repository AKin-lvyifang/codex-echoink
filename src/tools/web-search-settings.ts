/** The legacy `tavily.apiKey` remains the Tavily key so upgrades preserve it. */
export type WebSearchProvider = "tavily" | "deepseek";
export interface WebSearchSettings {
  enabled: boolean;
  apiKey: string;
  provider?: WebSearchProvider;
  deepseekApiKey?: string;
}
export type NormalizedWebSearchSettings = Required<WebSearchSettings>;
/** Model credentials stay in their provider configuration, never in search settings. */
export interface WebSearchModelProvider {
  readonly providerId?: string;
  readonly authMode?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}
export type WebSearchKeySource = "model" | "legacy" | "missing";
export const WEB_SEARCH_PROVIDERS = ["tavily", "deepseek"] as const;
export function webSearchProvider(settings: WebSearchSettings): WebSearchProvider { return settings.provider === "deepseek" ? "deepseek" : "tavily"; }
export function webSearchProviderName(settings: WebSearchSettings): "Tavily" | "DeepSeek" { return webSearchProvider(settings) === "deepseek" ? "DeepSeek" : "Tavily"; }
export function deepSeekModelApiKey(providers: readonly WebSearchModelProvider[] = []): string {
  for (const provider of providers) {
    if (provider.providerId !== "deepseek" || provider.authMode === "oauth" || !provider.apiKey?.trim()) continue;
    try {
      const url = new URL(provider.baseUrl);
      if (url.origin === "https://api.deepseek.com" && !url.username && !url.password && !url.search && !url.hash
        && ["/", "/v1", "/v1/"].includes(url.pathname)) return provider.apiKey.trim();
    } catch { /* Invalid and custom endpoints cannot supply an official search key. */ }
  }
  return "";
}
export function webSearchKeySource(settings: WebSearchSettings, providers: readonly WebSearchModelProvider[] = []): WebSearchKeySource {
  if (webSearchProvider(settings) === "deepseek" && deepSeekModelApiKey(providers)) return "model";
  return (webSearchProvider(settings) === "deepseek" ? settings.deepseekApiKey ?? "" : settings.apiKey).trim() ? "legacy" : "missing";
}
export function webSearchApiKey(settings: WebSearchSettings, providers: readonly WebSearchModelProvider[] = []): string {
  return webSearchProvider(settings) === "deepseek" ? deepSeekModelApiKey(providers) || settings.deepseekApiKey?.trim() || "" : settings.apiKey.trim();
}
export function setWebSearchApiKey(settings: WebSearchSettings, value: string): void {
  if (webSearchProvider(settings) === "deepseek") settings.deepseekApiKey = value.trim(); else settings.apiKey = value.trim();
}
export function webSearchAvailable(settings: WebSearchSettings, providers: readonly WebSearchModelProvider[] = []): boolean { return settings.enabled && Boolean(webSearchApiKey(settings, providers)); }
export function normalizeWebSearchSettings(value: unknown): NormalizedWebSearchSettings {
  const record = value && typeof value === "object" ? value as Partial<WebSearchSettings> : {};
  const normalized: NormalizedWebSearchSettings = { enabled: record.enabled === true, provider: record.provider === "deepseek" ? "deepseek" : "tavily",
    apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "", deepseekApiKey: typeof record.deepseekApiKey === "string" ? record.deepseekApiKey.trim() : "" };
  return normalized;
}
