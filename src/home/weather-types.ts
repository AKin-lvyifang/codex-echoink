export interface WeatherCity { id: string; name: string }
export interface WeatherCitySuggestion extends WeatherCity { admin1: string; admin2: string; country: string; countryName: string }
export type WeatherCategory = "clear" | "cloudy" | "rain" | "thunder" | "snow" | "fog" | "wind" | "other";
export type WeatherLayer = "fair" | "cloudy" | "overcast" | "drizzle" | "thunder" | "snow" | "fog" | "breeze" | "still" | "unknown";
export interface CurrentWeather {
  city: WeatherCity; category: WeatherCategory; description: string; temperature: number;
  updatedAt: number; fetchedAt: number; stale: boolean; source: "met-norway";
}
export function normalizeWeatherCity(value: unknown): WeatherCity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length > 80 || !/^(?:cn-\d{6}|tw-[A-Z]{3}|gn-\d+)$/u.test(record.id)
    || typeof record.name !== "string" || !record.name.trim() || [...record.name].length > 120) return null;
  return { id: record.id, name: record.name.trim() };
}
export function weatherLayer(weather: Pick<CurrentWeather, "category" | "description">): WeatherLayer {
  if (weather.category === "cloudy") return /^阴/u.test(weather.description) ? "overcast" : "cloudy";
  return ({ clear: "fair", rain: "drizzle", thunder: "thunder", snow: "snow", fog: "fog", wind: "breeze", other: "still" } as const)[weather.category] ?? "still";
}
