/** 「为你 / 和你有关」：只用本机的笔记标题和标签做字面匹配，不读正文、不调模型、不上传。 */
export interface NewsNoteSource { title: string; tags: readonly string[] }
export interface NewsRelevanceReason { kind: "note" | "tag"; name: string }
export interface NewsRelevance { reason: NewsRelevanceReason; weight: number }
export const NEWS_RELEVANCE_MAX_NOTES = 5000;
export const NEWS_RELEVANCE_MAX_TERMS = 20_000;

const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "into", "about", "your", "you", "are", "was", "has", "have", "not", "but", "all", "any", "can", "how", "what", "why",
  "new", "note", "notes", "untitled", "draft", "todo", "copy", "test", "readme", "index", "home", "inbox", "wiki", "daily", "journal", "review", "summary", "list", "plan", "log", "doc", "docs",
  "未命名", "笔记", "记录", "总结", "日记", "周报", "月报", "复盘", "草稿", "模板", "待办", "计划", "清单", "资料", "收集", "整理", "使用", "学习", "方案", "问题", "想法", "目录", "索引"]);
const LATIN = /[a-z][a-z0-9]*/gu;
const CJK = /[\u3400-\u9fff]+/gu;
const CJK_STOP = new RegExp([...STOP].filter(word => /[\u3400-\u9fff]/u.test(word)).join("|"), "u");

/** 从笔记标题或标签里取可匹配的词：英文按单词（≥3 字母），中文 2–4 字整段，更长的取 4 字片段。 */
export function newsTerms(text: string): string[] {
  const lower = text.toLowerCase(), terms = new Set<string>();
  for (const word of lower.match(LATIN) ?? []) if (word.length >= 3 && !STOP.has(word)) terms.add(word);
  // 先去掉「笔记、记录、总结」这类到处都有的词，再看剩下的片段。
  const runs: string[] = lower.match(CJK) ?? [];
  for (const text of runs) for (const run of text.split(CJK_STOP)) {
    if (run.length < 2) continue;
    if (run.length <= 4) { terms.add(run); continue; }
    for (let i = 0; i + 4 <= run.length; i++) terms.add(run.slice(i, i + 4));
  }
  return [...terms];
}
/** 资讯文字里可能出现的词：英文单词，加上每段中文的 2–4 字片段。 */
function textTerms(text: string): Set<string> {
  const lower = text.toLowerCase(), terms = new Set<string>(lower.match(LATIN) ?? []);
  for (const run of lower.match(CJK) ?? []) for (let size = 2; size <= 4; size++) for (let i = 0; i + size <= run.length; i++) terms.add(run.slice(i, i + size));
  return terms;
}
const weightOf = (term: string): number => /[\u3400-\u9fff]/u.test(term) ? term.length * 2 : Math.min(term.length, 12);

export interface NewsRelevanceIndex { terms: Map<string, NewsRelevanceReason>; notes: number }
/** 建一次索引；库很大时只取前 5000 篇笔记、最多 2 万个词。 */
export function buildNewsRelevanceIndex(notes: readonly NewsNoteSource[]): NewsRelevanceIndex {
  const terms = new Map<string, NewsRelevanceReason>();
  const add = (text: string, reason: NewsRelevanceReason) => { for (const term of newsTerms(text)) if (terms.size < NEWS_RELEVANCE_MAX_TERMS && !terms.has(term)) terms.set(term, reason); };
  const limited = notes.slice(0, NEWS_RELEVANCE_MAX_NOTES);
  for (const note of limited) add(note.title, { kind: "note", name: note.title });
  // 标题优先于标签：同一个词先被笔记占用时，理由显示笔记名。
  for (const note of limited) for (const raw of note.tags) { const tag = raw.replace(/^#/u, ""); if (tag) add(tag.replace(/\//gu, " "), { kind: "tag", name: tag }); }
  return { terms, notes: limited.length };
}
/** 返回每条资讯匹配到的理由。一个词命中超过四分之一的资讯就算太泛，不拿来当理由。 */
export function matchNewsRelevance(index: NewsRelevanceIndex, items: readonly { id: string; title: string; summary: string }[]): Map<string, NewsRelevance> {
  const result = new Map<string, NewsRelevance>();
  if (!index.terms.size || !items.length) return result;
  const hits = items.map(item => [...textTerms(`${item.title} ${item.summary}`)].filter(term => index.terms.has(term)));
  const frequency = new Map<string, number>();
  for (const terms of hits) for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const tooCommon = Math.max(3, Math.ceil(items.length / 4));
  hits.forEach((terms, position) => {
    let best: NewsRelevance | null = null;
    for (const term of terms) {
      if ((frequency.get(term) ?? 0) > tooCommon) continue;
      const weight = weightOf(term);
      if (!best || weight > best.weight) best = { reason: index.terms.get(term)!, weight };
    }
    if (best) result.set(items[position].id, best);
  });
  return result;
}
export function newsReasonText(reason: NewsRelevanceReason, english: boolean): string {
  return reason.kind === "note" ? (english ? `Note “${reason.name}”` : `笔记《${reason.name}》`) : (english ? `Tag #${reason.name}` : `标签 #${reason.name}`);
}
