/** 资讯数据：服务端 feed 的校验与页面要用的纯计算。服务端和 RSS 的文字一律当不可信纯文本。 */
export const NEWS_CATEGORIES = ["model", "product", "industry", "paper", "tutorial", "opinion"] as const;
export type NewsCategory = typeof NEWS_CATEGORIES[number];
export type NewsTrend = "new" | "up" | "flat" | "down";
export interface NewsItem {
  id: string; title: string; summary: string; url: string; source: string;
  category: NewsCategory; score: number; publishedAt: string; eventId: string;
}
export interface NewsEvent { id: string; title: string; heat: number; trend: NewsTrend; sourceCount: number; itemIds: string[] }
export interface NewsAnnouncement { text: string; url: string | null }
export interface NewsFeed {
  paused: boolean; announcement: NewsAnnouncement | null; version: 1; generatedAt: string | null;
  items: NewsItem[]; events: NewsEvent[]; lead: string[];
}
export const NEWS_MAX_ITEMS = 500;
export const NEWS_PAGE_SIZE = 30;

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** 折叠控制字符和换行，截到上限；不是字符串返回空串。 */
export function newsPlainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, max);
}
/** 外链只允许 http/https，且不带账号密码。 */
export function safeNewsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && url.hostname ? url.href : null;
  } catch { return null; }
}
const isoTime = (value: unknown): string | null => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
const idText = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;

/** 顶层结构不对就整体拒绝；单条不合格只丢这一条，不让一条坏数据拖垮整页。 */
export function parseNewsFeed(value: unknown): NewsFeed {
  const data = record(value);
  if (!data || typeof data.paused !== "boolean" || data.version !== 1 || !Array.isArray(data.items) || !Array.isArray(data.events) || !Array.isArray(data.lead)
    || !(data.generatedAt === null || isoTime(data.generatedAt))) throw new Error("NEWS_RESPONSE_INVALID");
  const notice = record(data.announcement), noticeText = newsPlainText(notice?.text, 200);
  const announcement = notice && noticeText ? { text: noticeText, url: safeNewsUrl(notice.url) } : null;
  const items: NewsItem[] = [], seen = new Set<string>();
  for (const raw of data.items.slice(0, NEWS_MAX_ITEMS)) {
    const item = record(raw), id = idText(item?.id), title = newsPlainText(item?.title, 300), url = safeNewsUrl(item?.url), publishedAt = isoTime(item?.publishedAt);
    if (!item || !id || seen.has(id) || !title || !url || !publishedAt || !NEWS_CATEGORIES.includes(item.category as NewsCategory)) continue;
    seen.add(id);
    items.push({ id, title, summary: newsPlainText(item.summary, 2000), url, source: newsPlainText(item.source, 80), category: item.category as NewsCategory,
      score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0, publishedAt, eventId: idText(item.eventId) ?? "" });
  }
  const events: NewsEvent[] = [], eventIds = new Set<string>();
  for (const raw of data.events.slice(0, NEWS_MAX_ITEMS)) {
    const event = record(raw), id = idText(event?.id), title = newsPlainText(event?.title, 300);
    const itemIds = Array.isArray(event?.itemIds) ? event.itemIds.filter((item): item is string => typeof item === "string" && seen.has(item)) : [];
    if (!event || !id || eventIds.has(id) || !title || !itemIds.length) continue;
    eventIds.add(id);
    events.push({ id, title, heat: typeof event.heat === "number" && Number.isFinite(event.heat) ? event.heat : 0,
      trend: (["new", "up", "flat", "down"] as const).find(trend => trend === event.trend) ?? "flat",
      sourceCount: typeof event.sourceCount === "number" && Number.isSafeInteger(event.sourceCount) && event.sourceCount > 0 ? event.sourceCount : 1, itemIds });
  }
  return { paused: data.paused, announcement, version: 1, generatedAt: data.generatedAt === null ? null : isoTime(data.generatedAt), items, events,
    lead: data.lead.filter((id): id is string => typeof id === "string" && eventIds.has(id)).slice(0, 3) };
}

/** 头条：每个头条事件取分数最高的一条，最多一大两小。 */
export function newsLeadItems(feed: NewsFeed): NewsItem[] {
  const items = new Map(feed.items.map(item => [item.id, item])), events = new Map(feed.events.map(event => [event.id, event]));
  const lead: NewsItem[] = [];
  for (const id of feed.lead) {
    const best = (events.get(id)?.itemIds ?? []).map(itemId => items.get(itemId)!).sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt))[0];
    if (best && !lead.includes(best)) lead.push(best);
  }
  return lead.slice(0, 3);
}
/** 热点榜：按热度从高到低，同热度保持服务端顺序。 */
export function newsHotEvents(feed: NewsFeed): NewsEvent[] {
  return feed.events.map((event, index) => ({ event, index })).sort((a, b) => b.event.heat - a.event.heat || a.index - b.index).map(entry => entry.event);
}
/** 热点点进去落到哪一条：事件里分数最高的那条。 */
export function newsEventItem(feed: NewsFeed, event: NewsEvent): NewsItem | null {
  const ids = new Set(event.itemIds);
  return feed.items.filter(item => ids.has(item.id)).sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt))[0] ?? null;
}
export function newsSourceCount(feed: NewsFeed, item: Pick<NewsItem, "eventId">): number {
  return feed.events.find(event => event.id === item.eventId)?.sourceCount ?? 1;
}
/** 搜索只在本机筛标题和摘要。 */
export function newsMatchesQuery(item: { title: string; summary?: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${item.title}\n${item.summary ?? ""}`.toLowerCase().includes(q);
}

export interface NewsDayGroup<T> { key: string; daysAgo: number; date: Date; items: T[] }
const dayStart = (time: number): number => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date.getTime(); };
/** 按本机日期分组，新的在前；daysAgo 0 是今天、1 是昨天。 */
export function newsDayGroups<T extends { publishedAt: string }>(items: readonly T[], now: number): NewsDayGroup<T>[] {
  const today = dayStart(now), groups = new Map<number, NewsDayGroup<T>>();
  for (const item of [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
    const start = dayStart(Date.parse(item.publishedAt));
    let group = groups.get(start);
    if (!group) { group = { key: String(start), daysAgo: Math.max(0, Math.round((today - start) / 86_400_000)), date: new Date(start), items: [] }; groups.set(start, group); }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}
export function newsDayLabel(group: Pick<NewsDayGroup<unknown>, "daysAgo" | "date">, english: boolean): string {
  const date = english ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(group.date) : `${group.date.getMonth() + 1} 月 ${group.date.getDate()} 日`;
  const relative = english ? (group.daysAgo === 0 ? "Today" : group.daysAgo === 1 ? "Yesterday" : `${group.daysAgo} days ago`)
    : group.daysAgo === 0 ? "今天" : group.daysAgo === 1 ? "昨天" : `${group.daysAgo} 天前`;
  return `${relative} · ${date}`;
}
const two = (value: number): string => String(value).padStart(2, "0");
export function newsClock(time: string | number): string { const date = new Date(time); return `${two(date.getHours())}:${two(date.getMinutes())}`; }
/** 页头的更新时间：当天只显示时分，跨天带上日期，避免把昨天的内容看成刚更新。 */
export function newsUpdatedLabel(time: string, now: number, english: boolean): string {
  const date = new Date(time), clock = newsClock(time);
  if (dayStart(date.getTime()) === dayStart(now)) return clock;
  return english ? `${new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date)} ${clock}` : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`;
}
export function newsRelativeTime(time: string, now: number, english: boolean): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(time)) / 60_000));
  if (minutes < 1) return english ? "Just now" : "刚刚";
  if (minutes < 60) return english ? `${minutes} min ago` : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return english ? `${hours} hr ago` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return english ? `${days} d ago` : `${days} 天前`;
}
