import { newsPlainText } from "./feed";
import { normalizeRssSubscriptions, type NewsRssSubscription } from "./rss";

/** 资讯页的用户配置：自定义 RSS 列表，以及已关闭的那条公告。 */
export interface NewsSettings { subscriptions: NewsRssSubscription[]; dismissedAnnouncement: string }
export function normalizeNewsSettings(value: unknown): NewsSettings {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { subscriptions: normalizeRssSubscriptions(data.subscriptions), dismissedAnnouncement: newsPlainText(data.dismissedAnnouncement, 2400) };
}
