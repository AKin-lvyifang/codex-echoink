import { countTextTokensAsync } from "../usage/token-estimator";
import type { MemoryDirectoryEntry } from "./memory-directory-selector";

/** A semantic catalog never applies activity or lexical eligibility as a filter. */
export function memoryDirectoryAllows(record: { status: string; pinned?: boolean; scope?: string; date: string }, boundary: { scope?: string; from?: string; to?: string } = {}): boolean {
  const scope = boundary.scope?.trim().toLowerCase(), actual = record.scope?.trim().toLowerCase();
  return record.status === "current" && !record.pinned
    && (!scope || !actual || actual === "global" || actual.replace(/^project:/u, "") === scope.replace(/^project:/u, ""))
    && (!boundary.from || record.date >= boundary.from) && (!boundary.to || record.date <= boundary.to);
}

export function directoryData(entry: MemoryDirectoryEntry): Record<string, unknown> {
  return { id: entry.id, title: entry.title,
    ...(entry.recallWhen.trim().normalize("NFKC").toLowerCase() === entry.title.trim().normalize("NFKC").toLowerCase() ? {} : { recallWhen: entry.recallWhen }),
    ...(entry.summary === undefined ? {} : { summary: entry.summary }), ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.date ? { date: entry.date } : {}) };
}

/** All entries first. Only an actual token/protocol overflow enables broad, interleaved screening. */
export interface PreparedMemoryCatalog { entries: readonly MemoryDirectoryEntry[]; text: string; tokens: number; originalCount: number; prefiltered: boolean; reason?: string }
export async function prepareMemoryCatalog(entries: readonly MemoryDirectoryEntry[], options: { tokenBudget: number; maxEntries?: number; renderEntry?: (entry: MemoryDirectoryEntry) => unknown }): Promise<PreparedMemoryCatalog> {
  const cap = Math.max(0, Math.floor(options.tokenBudget)), limit = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
  const byId = (a: MemoryDirectoryEntry, b: MemoryDirectoryEntry) => a.id.localeCompare(b.id);
  const renderEntry = options.renderEntry ?? directoryData;
  const render = (values: readonly MemoryDirectoryEntry[]) => {
    const ids = new Set(values.map(entry => entry.id));
    return `[\n${[...values].sort(byId).map(entry => JSON.stringify(renderEntry({ ...entry, related: entry.related?.filter(id => ids.has(id)) })).replace(/[<>&]/gu, c => c === "<" ? "\\u003c" : c === ">" ? "\\u003e" : "\\u0026")).join(",\n")}\n]`;
  };
  const rows = new Map(entries.map(entry => [entry.id, JSON.stringify(renderEntry(entry))]));
  const allText = render(entries), allTokens = await countTextTokensAsync(allText);
  if (entries.length <= limit && allTokens <= cap) return { entries, text: allText, tokens: allTokens, originalCount: entries.length, prefiltered: false };
  const hits = entries.filter(entry => (entry.score ?? 0) > 0).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || byId(a, b));
  const secondary = entries.filter(entry => entry.secondaryMatch).sort(byId);
  const matched = new Set([...hits, ...secondary].map(entry => entry.id));
  const neighborIds = new Set([...hits, ...secondary].flatMap(entry => entry.related ?? []));
  const neighbors = entries.filter(entry => neighborIds.has(entry.id) || entry.related?.some(id => matched.has(id))).sort(byId);
  const recent = [...entries].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || byId(a, b));
  const frequent = [...entries].sort((a, b) => b.activity - a.activity || byId(a, b));
  const channels = [hits, secondary, neighbors, recent, frequent];
  const seen = new Set<string>(), ranked: MemoryDirectoryEntry[] = [];
  for (let i = 0; i < entries.length; i++) for (const channel of channels) {
    const entry = channel[i]; if (entry && !seen.has(entry.id)) { seen.add(entry.id); ranked.push(entry); }
  }
  const included: MemoryDirectoryEntry[] = []; let estimated = await countTextTokensAsync("[\n\n]");
  for (const entry of ranked) {
    const cost = await countTextTokensAsync(rows.get(entry.id)!) + 2;
    if (included.length >= limit) break;
    if (estimated + cost > cap) continue;
    included.push(entry); estimated += cost;
  }
  let text = render(included), tokens = await countTextTokensAsync(text);
  while (included.length && tokens > cap) { included.pop(); text = render(included); tokens = await countTextTokensAsync(text); }
  return { entries: included, text, tokens, originalCount: entries.length, prefiltered: true,
    reason: entries.length > limit ? "protocol_limit" : "request_budget" };
}

/** Normalize only names actually present in the directory, preserving code/URLs/paths and unknown words. */
export function normalizeMemoryDirectoryNames(query: string, entries: readonly MemoryDirectoryEntry[]): string {
  const known = new Set<string>();
  for (const entry of entries) for (const match of `${entry.title} ${entry.summary ?? ""}`.matchAll(/\b[A-Za-z][A-Za-z0-9_]{2,}\b/gu)) {
    // Internal capitals identify directory names conservatively; ordinary Title Case and acronyms stay untouched.
    if (/[a-z][A-Z]/u.test(match[0])) known.add(match[0].toLowerCase());
  }
  const protectedText = /(```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|(?:^|\s)(?:\.{1,2}\/|~\/|\/)\S+)/gu;
  return query.split(protectedText).map((part, index) => index % 2 ? part : part.replace(/\b[A-Za-z][A-Za-z0-9_]*\b/gu,
    word => known.has(word.toLowerCase()) ? word.toLowerCase() : word)).join("");
}
