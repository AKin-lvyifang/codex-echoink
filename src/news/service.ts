import { parseNewsFeed, type NewsAnnouncement, type NewsFeed } from "./feed";

/** 资讯拉取与本地缓存：只存一份 JSON；10 分钟内不重复请求；带 ETag；出错时退回缓存。 */
export const NEWS_REFRESH_MS = 10 * 60_000;
export interface NewsFetchResult { status: number; json: unknown; etag: string | null }
export type NewsFetch = (etag: string | null, token: string) => Promise<NewsFetchResult>;
export interface NewsCacheStore { read(): Promise<string | null>; write(text: string): Promise<void>; remove(): Promise<void> }
export type NewsState =
  | { kind: "ready"; feed: NewsFeed; fetchedAt: number; offline: boolean }
  | { kind: "paused"; announcement: NewsAnnouncement | null }
  | { kind: "pro-required" }
  | { kind: "signed-out" }
  | { kind: "soon" }
  | { kind: "empty" };
interface CacheRecord { version: 1; etag: string | null; fetchedAt: number; feed: NewsFeed }

export class NewsService {
  private cache: CacheRecord | null | undefined;
  private flight: Promise<NewsState> | null = null;
  constructor(private readonly options: { fetch: NewsFetch; token: () => string | null; store: NewsCacheStore; now?: () => number }) {}
  private now(): number { return (this.options.now ?? Date.now)(); }

  private async readCache(): Promise<CacheRecord | null> {
    if (this.cache !== undefined) return this.cache;
    try {
      const text = await this.options.store.read(), data = text ? JSON.parse(text) as Partial<CacheRecord> : null;
      this.cache = data && data.version === 1 && typeof data.fetchedAt === "number" && Number.isFinite(data.fetchedAt) && (data.etag === null || typeof data.etag === "string")
        ? { version: 1, etag: data.etag, fetchedAt: data.fetchedAt, feed: parseNewsFeed(data.feed) } : null;
    } catch { this.cache = null; }
    return this.cache;
  }
  private async writeCache(cache: CacheRecord): Promise<void> {
    this.cache = cache;
    await this.options.store.write(JSON.stringify(cache)).catch(() => {});
  }
  private async clearCache(): Promise<void> {
    this.cache = null;
    await this.options.store.remove().catch(() => {});
  }
  /** 只读本地缓存，不发请求；给页面先垫一屏内容。 */
  async cached(): Promise<NewsState | null> {
    const cache = await this.readCache();
    return cache && this.options.token() ? { kind: "ready", feed: cache.feed, fetchedAt: cache.fetchedAt, offline: false } : null;
  }
  /** force 用于手动刷新；否则距上次成功拉取不到 10 分钟就直接用缓存。 */
  load(force = false): Promise<NewsState> {
    if (this.flight) return this.flight;
    this.flight = this.loadOnce(force).finally(() => { this.flight = null; });
    return this.flight;
  }
  private async loadOnce(force: boolean): Promise<NewsState> {
    const token = this.options.token();
    if (!token) return { kind: "signed-out" };
    const cache = await this.readCache();
    const fallback = (): NewsState => cache ? { kind: "ready", feed: cache.feed, fetchedAt: cache.fetchedAt, offline: true } : { kind: "empty" };
    if (!force && cache && this.now() - cache.fetchedAt >= 0 && this.now() - cache.fetchedAt < NEWS_REFRESH_MS) return { kind: "ready", feed: cache.feed, fetchedAt: cache.fetchedAt, offline: false };
    let response: NewsFetchResult;
    try { response = await this.options.fetch(cache?.etag ?? null, token); } catch { return fallback(); }
    if (response.status === 304 && cache) {
      const next = { ...cache, fetchedAt: this.now() };
      await this.writeCache(next);
      return { kind: "ready", feed: next.feed, fetchedAt: next.fetchedAt, offline: false };
    }
    if (response.status === 200) {
      let feed: NewsFeed;
      try { feed = parseNewsFeed(response.json); } catch { return fallback(); }
      if (feed.paused) { await this.clearCache(); return { kind: "paused", announcement: feed.announcement }; }
      const next: CacheRecord = { version: 1, etag: response.etag, fetchedAt: this.now(), feed };
      await this.writeCache(next);
      return { kind: "ready", feed, fetchedAt: next.fetchedAt, offline: false };
    }
    const code = response.json && typeof response.json === "object" ? (response.json as { error?: unknown }).error : undefined;
    if (response.status === 401) return { kind: "signed-out" };
    if (response.status === 403 && code === "PRO_REQUIRED") { await this.clearCache(); return { kind: "pro-required" }; }
    if (response.status === 403 && code === "NEWS_NOT_IN_ROLLOUT") { await this.clearCache(); return { kind: "soon" }; }
    return fallback();
  }
}
