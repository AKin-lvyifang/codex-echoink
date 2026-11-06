import { lexicalTokens, normalizeMatchText, type PrimaryScoreInput } from "./search-index-core";
import type { PersonalMemoryRecord } from "./personal-memory-contracts";

export interface MemoryActivity { lastRecalledAt: number; recallCount: number; lastTurnId?: string }
export interface MemoryActivityState { version: 1; vaultId: string; initializedAt: string; records: Record<string, MemoryActivity> }
export type MemoryLayer = "core" | "frequent" | "peripheral" | "faded";
export type MemoryRecallMode = "search" | "automatic";
const DAY = 86_400_000;
const HALF_LIVES = { fact: 60, view: 60, decision: 60, goal: 60, episode: 45, open_loop: 21, task: 14 } as const;
export const MEMORY_PIN_LIMIT = 10;
export const MEMORY_PIN_LIMIT_MESSAGE = "最多固定 10 条记忆，请先取消一条再固定。";

const AUTOMATIC_RECALL_STOP_WORDS = new Set([
  "什么", "一下", "一个", "这个", "那个", "这些", "那些", "怎么", "怎样", "如何", "是否", "帮我", "请问",
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "what", "which", "who", "when", "where", "why", "how", "this", "that", "these", "those",
  "i", "you", "we", "they", "it", "my", "your", "our", "their", "its", "and", "or", "of", "to", "in", "on", "at", "for", "with", "by", "from", "can", "could", "would", "should", "please"
]);
const AUTOMATIC_RECALL_DE_WORDS = new Set(["目的", "标的", "的士", "的确"]);

/** Desktop automatic recall only; explicit search and the stored index keep all tokens. */
export function automaticMemoryQueryTokens(query: string): string[] {
  const normalized = normalizeMatchText(query);
  const protectedNumbers = new Set<string>();
  // Protect numeric parts of versions and calendar dates, without changing tokenization.
  for (const match of normalized.matchAll(/v?\d+(?:\.\d+)+|\d{4}[-/]\d{1,2}[-/]\d{1,2}|(?:\d{2,4}年)?\d{1,2}月(?:\d{1,2}日)?|\d{2,4}年/gu)) {
    for (const token of lexicalTokens(match[0])) if (/^\p{N}+$/u.test(token)) protectedNumbers.add(token);
  }
  return lexicalTokens(query).filter(token => !AUTOMATIC_RECALL_STOP_WORDS.has(token)
    && !(token.length === 2 && token.includes("的") && !AUTOMATIC_RECALL_DE_WORDS.has(token))
    && (!/^\p{N}+$/u.test(token) || protectedNumbers.has(token)));
}

export function assertMemoryPinLimit(records: readonly Pick<PersonalMemoryRecord, "status" | "pinned">[]): void {
  if (records.filter(record => record.status === "current" && record.pinned).length > MEMORY_PIN_LIMIT) throw new Error(MEMORY_PIN_LIMIT_MESSAGE);
}

export function memoryRouteMatches(entry: Pick<PrimaryScoreInput, "title" | "recallWhen">, query: string): boolean {
  const normalized = normalizeMatchText(query.trim());
  if (!normalized) return false;
  const routes = [entry.title, entry.recallWhen].map(normalizeMatchText).filter(Boolean);
  return routes.some(route => route.includes(normalized) || route.length >= 2 && normalized.includes(route))
    || Array.from({ length: Math.max(0, normalized.length - 3) }, (_, index) => normalized.slice(index, index + 4))
      .some(phrase => !/\s/u.test(phrase) && routes.some(route => route.includes(phrase)));
}

/** Pure preview and production policy share this exact lifecycle calculation. */
export function memoryLifecycle(record: Pick<PersonalMemoryRecord, "id" | "kind" | "date" | "due" | "pinned">, state: MemoryActivityState, now: number): Readonly<{ activity: number; layer: MemoryLayer; multiplier: number }> {
  const hit = state.records[record.id];
  const last = hit?.lastRecalledAt ?? Math.max(Date.parse(record.date), Date.parse(state.initializedAt) - 30 * DAY);
  const halfLife = HALF_LIVES[record.kind] * (1 + 0.35 * Math.log2(1 + (hit?.recallCount ?? 0)));
  let activity = 0.5 ** (Math.max(0, now - last) / DAY / halfLife);
  const overdue = memoryTemporalContext(record, now).overdue === true;
  if (["fact", "view", "decision"].includes(record.kind) || record.kind === "task" && !!record.due && !overdue) activity = Math.max(0.2, activity);
  if (record.kind === "task" && overdue) activity *= 0.32;
  const layer: MemoryLayer = record.pinned ? "core" : activity >= 0.7 ? "frequent" : activity < 0.2 ? "faded" : "peripheral";
  return { activity, layer, multiplier: 0.5 + 0.5 * activity };
}

export function rankMemory(score: number, record: Pick<PersonalMemoryRecord, "id" | "kind" | "date" | "due" | "pinned" | "title" | "recallWhen">, state: MemoryActivityState, now: number, query: string, mode: MemoryRecallMode) {
  const lifecycle = memoryLifecycle(record, state, now);
  const direct = memoryRouteMatches(record, query);
  const eligible = mode === "search" || (!record.pinned && (lifecycle.layer !== "faded" || ["goal", "episode"].includes(record.kind) && direct));
  return { ...lifecycle, score: score * lifecycle.multiplier, eligible, recallReason: direct ? "title_or_trigger" as const : "content_or_association" as const };
}

/** Runtime-only lexical relevance. No index fields, clocks, storage or mutations. */
export function memoryRelevanceScorer(entries: readonly PrimaryScoreInput[], query: string, mode: MemoryRecallMode = "search", tokens: readonly string[] = lexicalTokens(query)): (entry: PrimaryScoreInput) => number {
  const documentFrequency = new Map<string, number>();
  for (const entry of entries) {
    for (const token of new Set([...entry.routeTokens, ...entry.contentTokens])) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  // Keep a small common-term weight: a collection about one topic must still
  // be searchable by that topic even when every record contains it.
  const weights = tokens.map(token => {
    const frequency = documentFrequency.get(token) ?? 0;
    return { token, weight: 0.2 + Math.log(1 + (entries.length - frequency + 0.5) / (frequency + 0.5)) };
  });
  const rawScore = (entry: PrimaryScoreInput) => {
    if (!tokens.length) return 0;
    const route = new Set(entry.routeTokens), content = new Set(entry.contentTokens);
    let matched = 0;
    for (const { token, weight } of weights) {
      if (route.has(token)) matched += 3 * weight;
      if (content.has(token)) matched += weight;
    }
    if (!matched) return 0;
    // Unique lexical tokens are already present in index v3. Longer records
    // must supply stronger evidence rather than winning through more words.
    const length = Math.sqrt((1 + route.size / 8 + content.size / 24) * tokens.length);
    const phrase = memoryRouteMatches(entry, query) ? 3 : 0;
    return matched / length + phrase;
  };
  const scores = new Map(entries.map(entry => [entry, rawScore(entry)]));
  // A clear topic hit also sets a relative floor, excluding generic overlap
  // that would otherwise ride alongside it. Broad, equally relevant searches
  // remain pageable even when their terms occur in every record.
  const minimum = mode === "automatic" ? [...scores.values()].reduce((floor, score) => Math.max(floor, score * 0.6), 0.35) : 0.35;
  return entry => {
    const score = scores.get(entry) ?? rawScore(entry);
    return score >= minimum ? score : 0;
  };
}

export function memoryRelevanceEntry(record: Readonly<{ title: string; recallWhen: string; content: string }>): PrimaryScoreInput {
  return { title: record.title, recallWhen: record.recallWhen,
    routeTokens: lexicalTokens(`${record.title}\n${record.recallWhen}`), contentTokens: lexicalTokens(record.content) };
}

/** Calendar dates are compared as dates; date-time deadlines use their offset. */
export function memoryTemporalContext(record: Readonly<{ date: string; due?: string }>, now: number): Readonly<{ daysAgo: number; due?: string; overdue?: boolean }> {
  const today = new Date(now).toISOString().slice(0, 10);
  return {
    daysAgo: Math.max(0, Math.floor((Date.parse(today) - Date.parse(record.date)) / 86_400_000)),
    ...(record.due ? { due: record.due, overdue: record.due.length === 10 ? record.due < today : Date.parse(record.due) < now } : {})
  };
}
