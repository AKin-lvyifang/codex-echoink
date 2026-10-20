/** Persisted settings only; usable without Obsidian or a network transport. */
export interface TavilySettings { enabled: boolean; apiKey: string }

export function normalizeTavilySettings(value: unknown): TavilySettings {
  const record = value && typeof value === "object" ? value as Partial<TavilySettings> : {};
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  return { enabled: record.enabled === true && Boolean(apiKey), apiKey };
}
