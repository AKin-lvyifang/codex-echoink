import type { MemoryDirectoryEntry } from "./memory-directory-selector";
import { countTextTokensAsync } from "../usage/token-estimator";

export async function buildMemoryNavigation(entries: readonly MemoryDirectoryEntry[], delivered: ReadonlySet<string>, tokenBudget: number) {
  const remaining = entries.filter(entry => !delivered.has(entry.id));
  const ranked = [...remaining].sort((a, b) => b.activity - a.activity || (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  const render = (items: readonly MemoryDirectoryEntry[]) => [
    '<echoink_memory_directory trust="untrusted-navigation-data">',
    ...items.map(entry => `${entry.id} | ${entry.title.replace(/[|\r\n]/gu, " ").replace(/[<>&]/gu, c => c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")} | ${entry.kind ?? ""} | ${entry.date ?? ""}`),
    ...(items.length < remaining.length ? [`另有 ${remaining.length - items.length} 条，用 memory_search 查找。`] : []),
    '</echoink_memory_directory>'
  ].join("\n");
  const cap = Math.max(0, Math.min(1_500, tokenBudget));
  const selected: MemoryDirectoryEntry[] = [];
  for (const entry of ranked) if (await countTextTokensAsync(render([...selected, entry])) <= cap) selected.push(entry);
  const content = selected.length ? render(selected) : "";
  return { content, total: remaining.length, listed: selected.length, truncated: selected.length < remaining.length,
    tokens: await countTextTokensAsync(content) };
}
