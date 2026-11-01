import type CodexForObsidianPlugin from "../main";
import { MembershipApiError, type MembershipTransport } from "../membership/account-service";
import { createMembershipTransport, membershipApiUrl } from "../membership/transport";
import { normalizeWeatherCity, type CurrentWeather, type WeatherCategory, type WeatherCitySuggestion } from "./weather-types";

export const WEATHER_REFRESH_MS = 30 * 60_000;
const categories = new Set<WeatherCategory>(["clear", "cloudy", "rain", "thunder", "snow", "fog", "wind", "other"]);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MembershipApiError("WEATHER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
};

/** Public weather uses the existing transport with no account token, cookies or device identity. */
export class WorkbenchWeatherService {
  private readonly transport: MembershipTransport;
  private readonly now: () => number;
  private searchUntil = 0;
  private currentUntil = 0;
  private cache?: { value: CurrentWeather; at: number };
  private readonly flights = new Map<string, Promise<CurrentWeather>>();
  constructor(options: { transport?: MembershipTransport; now?: () => number } = {}) {
    this.transport = options.transport ?? createMembershipTransport(membershipApiUrl); this.now = options.now ?? Date.now;
  }
  private async request(endpoint: string, search: boolean): Promise<unknown> {
    const until = search ? this.searchUntil : this.currentUntil;
    if (until > this.now()) throw new MembershipApiError("RATE_LIMITED", Math.ceil((until - this.now()) / 1000));
    try { return await this.transport(endpoint, "GET", undefined); }
    catch (error) {
      if (error instanceof MembershipApiError && error.code === "RATE_LIMITED") {
        const next = this.now() + (error.retryAfter ?? 60) * 1000;
        if (search) this.searchUntil = next; else this.currentUntil = next;
      }
      throw error;
    }
  }
  async searchCities(query: string): Promise<WeatherCitySuggestion[]> {
    query = query.trim();
    if (!query || [...query].length > 32) throw new MembershipApiError("INVALID_INPUT");
    const result = record(await this.request(`/api/weather/cities?q=${encodeURIComponent(query)}`, true));
    if (!Array.isArray(result.cities) || result.cities.length > 10) throw new MembershipApiError("WEATHER_RESPONSE_INVALID");
    return result.cities.map((value: unknown) => {
      const city = normalizeWeatherCity(value), fields = record(value);
      if (!city || ["admin1", "admin2", "country", "countryName"].some(key => typeof fields[key] !== "string")) throw new MembershipApiError("WEATHER_RESPONSE_INVALID");
      return { ...city, admin1: fields.admin1 as string, admin2: fields.admin2 as string, country: fields.country as string, countryName: fields.countryName as string };
    });
  }
  current(cityId: string, force = false): Promise<CurrentWeather> {
    if (this.flights.has(cityId)) return this.flights.get(cityId)!;
    if (!force && this.cache?.value.city.id === cityId && this.now() - this.cache.at < WEATHER_REFRESH_MS) return Promise.resolve(this.cache.value);
    const flight = this.request(`/api/weather/current?city=${encodeURIComponent(cityId)}`, false).then(input => {
      const value = record(input), city = normalizeWeatherCity(value.city);
      if (!city || city.id !== cityId || typeof value.category !== "string" || typeof value.description !== "string" || !value.description.trim()
        || value.description.length > 160 || typeof value.temperature !== "number" || !Number.isFinite(value.temperature)
        || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0
        || typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0
        || typeof value.stale !== "boolean" || value.source !== "met-norway") throw new MembershipApiError("WEATHER_RESPONSE_INVALID");
      const weather: CurrentWeather = { city, category: categories.has(value.category as WeatherCategory) ? value.category as WeatherCategory : "other",
        description: value.description, temperature: value.temperature, updatedAt: value.updatedAt, fetchedAt: value.fetchedAt, stale: value.stale, source: "met-norway" };
      this.cache = { value: weather, at: this.now() }; return weather;
    }).finally(() => { this.flights.delete(cityId); });
    this.flights.set(cityId, flight); return flight;
  }
}
const services = new WeakMap<CodexForObsidianPlugin, WorkbenchWeatherService>();
export function workbenchWeather(plugin: CodexForObsidianPlugin): WorkbenchWeatherService {
  let service = services.get(plugin); if (!service) { service = new WorkbenchWeatherService(); services.set(plugin, service); } return service;
}
