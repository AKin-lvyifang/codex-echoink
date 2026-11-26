/** 日记人格彩蛋：不依赖 Obsidian 的纯逻辑，便于测试。接口约定见 echoink-web docs/规范/会员接口约定.md「日记人格」。 */

export const PERSONA_MIN_ENTRIES = 8;
export const PERSONA_MIN_CHARS = 100;
export const PERSONA_PAIRS = [["E", "I"], ["S", "N"], ["T", "F"], ["J", "P"]] as const;
const PAIR_NAMES = {
  zh: [["外向", "内向"], ["实感", "直觉"], ["思考", "情感"], ["判断", "感知"]],
  en: [["Extraverted", "Introverted"], ["Sensing", "Intuitive"], ["Thinking", "Feeling"], ["Judging", "Perceiving"]],
} as const;

export interface PersonaQuote { date: string; text: string }
export interface PersonaDim { letter: string; percent: number; quotes: PersonaQuote[] }
export interface PersonaResult { month: string; type: string; name: string; keywords: string[]; summary: string; dims: PersonaDim[]; entries: number; model: string; generatedAt: number }
export interface DiaryPersonaState {
  /** 按日记月份（YYYY-MM）保存的最近一次结果。 */
  results: Record<string, PersonaResult>;
  /** 入口已经“出场”过的月份：第一次出现时弹一下，之后安静显示。 */
  seen: string[];
}
export interface PersonaEntry { date: string; path: string; text: string }

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function pairName(index: number, letter: string, zh: boolean): string {
  const pair = PERSONA_PAIRS[index], names = PAIR_NAMES[zh ? "zh" : "en"][index];
  return names[pair.indexOf(letter as never)] ?? letter;
}

function normalizeResult(raw: unknown): PersonaResult | null {
  const r = raw as Partial<PersonaResult> | null;
  if (!r || typeof r !== "object" || typeof r.month !== "string" || !MONTH.test(r.month) || typeof r.name !== "string" || typeof r.summary !== "string"
    || !Array.isArray(r.dims) || r.dims.length !== 4 || !Array.isArray(r.keywords)) return null;
  const dims: PersonaDim[] = [];
  for (const [index, dim] of r.dims.entries()) {
    if (!dim || !(PERSONA_PAIRS[index] as readonly string[]).includes(dim.letter) || !Number.isFinite(dim.percent)) return null;
    const quotes = Array.isArray(dim.quotes) ? dim.quotes.filter(q => q && typeof q.date === "string" && DATE.test(q.date) && typeof q.text === "string").slice(0, 2) : [];
    dims.push({ letter: dim.letter, percent: Math.min(100, Math.max(50, Math.round(dim.percent))), quotes: quotes.map(q => ({ date: q.date, text: q.text })) });
  }
  return { month: r.month, type: dims.map(d => d.letter).join(""), name: r.name, keywords: r.keywords.filter((k): k is string => typeof k === "string").slice(0, 3),
    summary: r.summary, dims, entries: Number.isFinite(r.entries) ? Number(r.entries) : 0, model: typeof r.model === "string" ? r.model : "", generatedAt: Number.isFinite(r.generatedAt) ? Number(r.generatedAt) : 0 };
}

export function normalizeDiaryPersonaState(raw: unknown): DiaryPersonaState {
  const value = raw as Partial<DiaryPersonaState> | null | undefined;
  const results: Record<string, PersonaResult> = {};
  if (value?.results && typeof value.results === "object") for (const [month, result] of Object.entries(value.results)) {
    const normalized = normalizeResult(result);
    if (normalized && normalized.month === month) results[month] = normalized;
  }
  const seen = Array.isArray(value?.seen) ? [...new Set(value.seen.filter((m): m is string => typeof m === "string" && MONTH.test(m)))].slice(-120) : [];
  return { results, seen };
}
export function acceptPersonaResult(raw: unknown): PersonaResult | null { return normalizeResult(raw); }

/** 日记正文：去掉 frontmatter、注释、图片和 Markdown 记号，保留换行，链接只留文字。 */
export function journalBodyText(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "").replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_match, target: string, label?: string) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*/gmu, "")
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gmu, "").replace(/[`*_~]/gu, "").replace(/\n{3,}/gu, "\n\n").trim();
}
/** 只数非空白字符：中文按字、英文按字母，和服务端口径一致。 */
export const bodyChars = (text: string) => text.replace(/\s/gu, "").length;
export function eligibleEntries<T extends { text: string }>(entries: readonly T[]): T[] { return entries.filter(entry => bodyChars(entry.text) >= PERSONA_MIN_CHARS); }
export const isPersonaEligible = (entries: readonly { text: string }[]) => eligibleEntries(entries).length >= PERSONA_MIN_ENTRIES;

export function monthKey(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; }
export function previousMonthKey(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, "0")}`;
}
export const monthNumber = (month: string) => Number(month.slice(5, 7));
/** 当月还没过完：结果可重新生成；过完之后定格。 */
export const isMonthOpen = (month: string, now = new Date()) => month >= monthKey(now);

export interface PersonaDelta { flipFrom?: string; delta?: number }
/** 较上月：字母翻转写来源字母；同侧写强度差。没有上月结果返回 null。 */
export function personaDelta(current: PersonaResult, previous: PersonaResult | null | undefined): PersonaDelta[] | null {
  if (!previous) return null;
  return current.dims.map((dim, index) => {
    const before = previous.dims[index];
    return before.letter !== dim.letter ? { flipFrom: before.letter } : { delta: dim.percent - before.percent };
  });
}

export function personaRequestBody(month: string, language: "zh" | "en", entries: readonly PersonaEntry[], previous: PersonaResult | null | undefined) {
  return {
    month, language, entries: eligibleEntries(entries).map(entry => ({ date: entry.date, text: entry.text })),
    previous: previous ? { month: previous.month, type: previous.type, dims: previous.dims.map(d => ({ letter: d.letter, percent: d.percent })) } : null,
  };
}

/** 「存入笔记」：结果 + 总结 + 原句，原句后用双链指回原日记。 */
export function personaMarkdown(result: PersonaResult, linkFor: (date: string) => string | null, zh: boolean, previous?: PersonaResult | null): string {
  const m = monthNumber(result.month), year = result.month.slice(0, 4);
  const deltas = personaDelta(result, previous);
  const lines = [
    "---", `month: ${result.month}`, `type: ${result.type}`, `entries: ${result.entries}`, "tags: [echoink/diary-persona]", "---", "",
    zh ? `# ${year} 年 ${m} 月人格：${result.type}` : `# ${result.month} persona: ${result.type}`, "",
    `**${result.name}** · ${result.keywords.join(" · ")}`, "", result.summary, "",
  ];
  result.dims.forEach((dim, index) => {
    const delta = deltas?.[index];
    const change = !delta ? "" : delta.flipFrom ? (zh ? `（由 ${delta.flipFrom} 转来）` : ` (from ${delta.flipFrom})`) : delta.delta ? (zh ? `（较上月 ${delta.delta > 0 ? "+" : ""}${delta.delta}）` : ` (${delta.delta > 0 ? "+" : ""}${delta.delta} vs last month)`) : "";
    lines.push(`## ${dim.letter} · ${pairName(index, dim.letter, zh)} ${dim.percent}%${change}`, "");
    for (const quote of dim.quotes) {
      const link = linkFor(quote.date);
      lines.push(`> ${quote.text}`, `> — ${!link ? quote.date : link === quote.date ? `[[${link}]]` : `[[${link}|${quote.date}]]`}`, "");
    }
  });
  lines.push(zh ? `依据 ${result.entries} 篇日记，由 EchoInk 生成。` : `Based on ${result.entries} journal entries, generated by EchoInk.`, "");
  return lines.join("\n");
}

export type PersonaErrorCode = "SIGN_IN" | "NOT_ENOUGH_ENTRIES" | "PERSONA_MONTH_LIMIT" | "PERSONA_PERIOD_LIMIT" | "PERSONA_DAILY_CAP" | "PERSONA_BUSY" | "NETWORK" | "UNAVAILABLE";
export function personaErrorCode(status: number, json: unknown): PersonaErrorCode {
  const code = (json as { error?: unknown } | null)?.error;
  if (status === 401) return "SIGN_IN";
  if (code === "NOT_ENOUGH_ENTRIES" || code === "PERSONA_MONTH_LIMIT" || code === "PERSONA_PERIOD_LIMIT" || code === "PERSONA_DAILY_CAP" || code === "PERSONA_BUSY") return code;
  return "UNAVAILABLE";
}
/** 报错文案：正式、先结果后下一步。 */
export function personaErrorText(code: PersonaErrorCode, zh: boolean, resetAt?: string | null): string {
  const reset = resetAt ? new Date(resetAt) : null;
  const when = reset && !Number.isNaN(reset.getTime()) ? (zh ? `${reset.getMonth() + 1} 月 ${reset.getDate()} 日` : reset.toLocaleDateString("en", { month: "short", day: "numeric" })) : "";
  switch (code) {
    case "SIGN_IN": return zh ? "未登录 EchoInk 账号。请在 设置 → 账号与会员 中登录后再生成。" : "Not signed in. Sign in under Settings → Account & membership, then try again.";
    case "NOT_ENOUGH_ENTRIES": return zh ? `本月有效日记不足 ${PERSONA_MIN_ENTRIES} 篇，暂时无法生成。` : `Fewer than ${PERSONA_MIN_ENTRIES} qualifying entries this month.`;
    case "PERSONA_MONTH_LIMIT": return zh ? "该月份的生成次数已用完。" : "No generations left for this month.";
    case "PERSONA_PERIOD_LIMIT": return zh ? `本月生成次数已用完${when ? `，${when}恢复` : ""}。` : `Monthly generations used up${when ? `; available again on ${when}` : ""}.`;
    case "PERSONA_DAILY_CAP": return zh ? "今日生成次数已达上限，请明天再试。" : "Today's generation limit has been reached. Try again tomorrow.";
    case "PERSONA_BUSY": return zh ? "正在生成中，请稍候。" : "Already generating. Please wait.";
    case "NETWORK": return zh ? "网络连接失败，请检查网络后重试。" : "Network connection failed. Check your network and try again.";
    default: return zh ? "生成失败，请稍后重试。" : "Generation failed. Try again later.";
  }
}
