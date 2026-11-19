import { newsPlainText, safeNewsUrl } from "./feed";

/** 自定义 RSS：只在本机拉取和解析，不经过 EchoInk 服务器、不调模型；内容一律当不可信纯文本。 */
export interface NewsRssSubscription { url: string; title: string }
export interface NewsRssItem { id: string; title: string; summary: ""; url: string; source: string; publishedAt: string; mine: true }
export type NewsRssRequest = (url: string) => Promise<{ status: number; text: string }>;
export type NewsRssErrorCode = "EMPTY" | "INVALID_URL" | "DUPLICATE" | "LIMIT" | "FETCH_FAILED" | "NOT_A_FEED";
export class NewsRssError extends Error { constructor(readonly code: NewsRssErrorCode) { super(code); } }
export const NEWS_RSS_MAX_SUBSCRIPTIONS = 20;
export const NEWS_RSS_MAX_ITEMS = 30;
export const NEWS_RSS_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** 补全协议并校验：只接受 http/https、带域名、不带账号密码的地址。 */
export function normalizeRssUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new NewsRssError("EMPTY");
  if (/\s/u.test(value)) throw new NewsRssError("INVALID_URL");
  const url = safeNewsUrl(/^[a-z][a-z0-9+.-]*:/iu.test(value) ? value : `https://${value}`);
  if (!url || !new URL(url).hostname.includes(".")) throw new NewsRssError("INVALID_URL");
  return url;
}
export function normalizeRssSubscriptions(value: unknown): NewsRssSubscription[] {
  if (!Array.isArray(value)) return [];
  const result: NewsRssSubscription[] = [];
  for (const raw of value) {
    const url = safeNewsUrl((raw as { url?: unknown } | null)?.url);
    if (!url || result.some(item => item.url === url)) continue;
    result.push({ url, title: newsPlainText((raw as { title?: unknown }).title, 80) || new URL(url).hostname });
    if (result.length >= NEWS_RSS_MAX_SUBSCRIPTIONS) break;
  }
  return result;
}
const hash = (text: string): string => {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0; b = Math.imul(b + text.charCodeAt(i), 0x85ebca6b) >>> 0; }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
};
const child = (parent: Element, name: string): Element | null => Array.from(parent.children).find(node => node.localName === name) ?? null;
const childText = (parent: Element, name: string, max: number): string => newsPlainText(child(parent, name)?.textContent ?? "", max);

/** 解析 RSS 2.0 / RDF / Atom。只取标题、链接和时间；正文和 HTML 一概不要。 */
export function parseRssFeed(xml: string, feedUrl: string, now: number, parser: DOMParser = new DOMParser()): { title: string; items: NewsRssItem[] } {
  if (xml.length > MAX_BYTES) throw new NewsRssError("NOT_A_FEED");
  const doc = parser.parseFromString(xml, "text/xml"), root = doc.documentElement;
  if (!root || doc.getElementsByTagName("parsererror").length) throw new NewsRssError("NOT_A_FEED");
  const atom = root.localName === "feed", channel = atom ? root : child(root, "channel");
  if (!atom && !(channel && (root.localName === "rss" || root.localName === "RDF"))) throw new NewsRssError("NOT_A_FEED");
  const host = new URL(feedUrl).hostname, title = (channel ? childText(channel, "title", 80) : "") || host;
  const entries = atom ? Array.from(root.children).filter(node => node.localName === "entry")
    : [...Array.from(channel!.children), ...Array.from(root.children)].filter(node => node.localName === "item");
  const items: NewsRssItem[] = [], seen = new Set<string>();
  for (const entry of entries) {
    if (items.length >= NEWS_RSS_MAX_ITEMS) break;
    const links = Array.from(entry.children).filter(node => node.localName === "link");
    const href = atom ? (links.find(link => (link.getAttribute("rel") ?? "alternate") === "alternate") ?? links[0])?.getAttribute("href") ?? "" : (links[0]?.textContent ?? "").trim();
    let url: string | null = null;
    try { url = safeNewsUrl(new URL(href, feedUrl).href); } catch { url = null; }
    const itemTitle = childText(entry, "title", 300);
    if (!url || !itemTitle || seen.has(url)) continue;
    seen.add(url);
    const time = Date.parse(atom ? childText(entry, "published", 60) || childText(entry, "updated", 60) : childText(entry, "pubDate", 60) || childText(entry, "date", 60));
    items.push({ id: `rss-${hash(url)}`, title: itemTitle, summary: "", url, source: title, publishedAt: new Date(Number.isFinite(time) ? Math.min(time, now) : now).toISOString(), mine: true });
  }
  return { title, items };
}
export async function fetchRssFeed(url: string, request: NewsRssRequest, now: number, parser?: DOMParser): Promise<{ title: string; items: NewsRssItem[] }> {
  let response: { status: number; text: string };
  let timer: number | undefined;
  try {
    response = await Promise.race([
      request(url),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new NewsRssError("FETCH_FAILED")), NEWS_RSS_TIMEOUT_MS); })
    ]);
  } catch { throw new NewsRssError("FETCH_FAILED"); }
  finally { if (timer !== undefined) window.clearTimeout(timer); }
  if (response.status < 200 || response.status >= 300 || typeof response.text !== "string") throw new NewsRssError("FETCH_FAILED");
  return parseRssFeed(response.text, url, now, parser);
}
/** 校验并试拉一次，通过才算添加成功。 */
export async function addRssSubscription(current: readonly NewsRssSubscription[], input: string, request: NewsRssRequest, now: number, parser?: DOMParser): Promise<{ subscription: NewsRssSubscription; items: NewsRssItem[] }> {
  const url = normalizeRssUrl(input);
  if (current.some(item => item.url === url)) throw new NewsRssError("DUPLICATE");
  if (current.length >= NEWS_RSS_MAX_SUBSCRIPTIONS) throw new NewsRssError("LIMIT");
  const feed = await fetchRssFeed(url, request, now, parser);
  return { subscription: { url, title: feed.title }, items: feed.items };
}
export function rssErrorText(code: NewsRssErrorCode, english: boolean): string {
  const text: Record<NewsRssErrorCode, [string, string]> = {
    EMPTY: ["先粘贴一个 RSS 地址", "Paste an RSS address first"],
    INVALID_URL: ["这不是有效的 RSS 地址", "This is not a valid RSS address"],
    DUPLICATE: ["这个地址已经添加过了", "This address is already added"],
    LIMIT: [`最多添加 ${NEWS_RSS_MAX_SUBSCRIPTIONS} 个订阅`, `You can add up to ${NEWS_RSS_MAX_SUBSCRIPTIONS} feeds`],
    FETCH_FAILED: ["读取不到这个地址，请检查后重试", "This address could not be reached. Check it and try again"],
    NOT_A_FEED: ["这个地址不是 RSS 或 Atom 订阅", "This address is not an RSS or Atom feed"]
  };
  return text[code][english ? 1 : 0];
}

/** 本机订阅内容只留在内存里；页面打开且超过 10 分钟才重新拉取。 */
export class NewsRssService {
  private items: NewsRssItem[] = [];
  private fetchedAt = 0;
  private signature = "";
  private flight: Promise<NewsRssItem[]> | null = null;
  private readonly updates = new Set<(items: NewsRssItem[]) => void>();
  constructor(private readonly request: NewsRssRequest, private readonly refreshMs: number, private readonly now: () => number = Date.now) {}
  snapshot(): NewsRssItem[] { return this.items; }
  forget(): void { this.signature = ""; }
  load(subscriptions: readonly NewsRssSubscription[], force = false, onUpdate?: (items: NewsRssItem[]) => void): Promise<NewsRssItem[]> {
    const signature = subscriptions.map(item => item.url).join("\n");
    if (!subscriptions.length) { this.items = []; this.signature = ""; return Promise.resolve(this.items); }
    if (!force && signature === this.signature && this.now() - this.fetchedAt < this.refreshMs) return Promise.resolve(this.items);
    if (onUpdate) this.updates.add(onUpdate);
    if (this.flight) return this.flight;
    const previous = new Map<string, NewsRssItem[]>();
    for (const item of this.items) previous.set(item.source, [...(previous.get(item.source) ?? []), item]);
    const results = subscriptions.map(item => previous.get(item.title) ?? []);
    this.flight = Promise.all(subscriptions.map((item, index) => fetchRssFeed(item.url, this.request, this.now()).then(feed => {
      results[index] = feed.items.map(entry => ({ ...entry, source: item.title }));
      // 每个订阅独立更新；慢订阅或失败只保留它自己的旧内容。
      this.items = results.flat().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      for (const update of this.updates) update(this.items);
    }, () => {})))
      .then(() => {
        this.items = results.flat().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
        this.fetchedAt = this.now(); this.signature = signature;
        return this.items;
      }).finally(() => { this.flight = null; this.updates.clear(); });
    return this.flight;
  }
}
