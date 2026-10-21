/** Display only. Never changes stored timestamps or the desktop account model. */
type MobileDate = number | string | Date | null | undefined;
const pad = (value: number): string => String(value).padStart(2, "0");
function dateOf(value: MobileDate): Date | undefined {
  if (value === null || value === undefined || value === "") return;
  const local = typeof value === "string" ? /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(value.trim()) : null;
  const date = local ? new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4] ?? 0), Number(local[5] ?? 0), Number(local[6] ?? 0)) : new Date(value instanceof Date ? value.getTime() : value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
export function formatMobileDate(value: MobileDate): string {
  const date = dateOf(value);
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : "—";
}
export function formatMobileClock(value: MobileDate): string {
  const date = dateOf(value);
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : "—";
}
export function formatMobileDateGroup(value: MobileDate, now = Date.now(), language = "zh-CN"): string {
  const date = dateOf(value), today = new Date(now), yesterday = new Date(now);
  if (!date) return "—";
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return language === "en" ? "Today" : "今天";
  if (date.toDateString() === yesterday.toDateString()) return language === "en" ? "Yesterday" : "昨天";
  if (date.getFullYear() !== today.getFullYear()) return formatMobileDate(date);
  return language === "en" ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getMonth() + 1}月${date.getDate()}日`;
}
export function formatMobileDateTime(value: MobileDate, now = Date.now(), language = "zh-CN"): string {
  const group = formatMobileDateGroup(value, now, language);
  return ["今天", "昨天", "Today", "Yesterday"].includes(group) ? `${group} ${formatMobileClock(value)}` : group;
}

/** Journal list headings keep their calendar date, including today and yesterday. */
export function formatMobileDiaryHeading(value: MobileDate, language = "zh-CN"): string {
  const date = dateOf(value);
  if (!date) return "—";
  if (language === "en") return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", weekday: "short" }).format(date);
  return `${date.getMonth() + 1}月${date.getDate()}日 周${"日一二三四五六"[date.getDay()]}`;
}

/** Display only: the saved due time remains intact for editing and reminders. */
export function formatMobileDueDate(value: MobileDate, now = Date.now(), language = "zh-CN"): string {
  const date = dateOf(value), today = dateOf(new Date(now));
  if (!date || !today) return "—";
  const day = (d: Date): number => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
  const delta = day(date) - day(today);
  if (delta === 0) return language === "en" ? "Today" : "今天";
  const offset = (today.getDay() + 6) % 7, week = Math.floor((delta + offset) / 7);
  if (delta > 0 && week <= 1) return language === "en" ? `${week === 1 ? "Next " : ""}${new Intl.DateTimeFormat("en", { weekday: "short" }).format(date)}` : `${week === 1 ? "下周" : "周"}${"日一二三四五六"[date.getDay()]}`;
  return language === "en" ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getMonth() + 1}月${date.getDate()}日`;
}
