import { type App, TFile } from "obsidian";
import { isHomeNotePath, type HomeNoteVisibility } from "./home-note-visibility";

export interface HomeSearchMatch { path: string; title: string; mtime: number; snippet: string }
interface CachedSearchText { mtime: number; text: string }

/** Bound retained text, not just result count. Character budgets use UTF-16 units. */
class SearchTextCache extends Map<string, CachedSearchText> {
  private characters = 0;
  constructor(private readonly maxEntries: number, private readonly maxCharacters: number, private readonly maxFileCharacters: number) { super(); }
  override get(path: string): CachedSearchText | undefined {
    const value = super.get(path);
    if (value) { super.delete(path); super.set(path, value); }
    return value;
  }
  override set(path: string, value: CachedSearchText): this {
    this.delete(path);
    if (value.text.length > this.maxFileCharacters) return this;
    super.set(path, value);
    this.characters += value.text.length;
    for (const path of this.keys()) {
      if (this.size <= this.maxEntries && this.characters <= this.maxCharacters) break;
      this.delete(path);
    }
    return this;
  }
  override delete(path: string): boolean {
    const value = super.get(path);
    if (value) this.characters -= value.text.length;
    return super.delete(path);
  }
  override clear(): void { super.clear(); this.characters = 0; }
}

/** Metadata first, then on-demand content; new input cancels old work between reads. */
export class HomeSearchService {
  private readonly cache = new SearchTextCache(256, 128_000, 8_192);
  private readonly contentCache = new SearchTextCache(64, 1_000_000, 262_144);
  constructor(private readonly app: App, private readonly includeNotePath: HomeNoteVisibility = isHomeNotePath) {}
  clear(): void { this.cache.clear(); this.contentCache.clear(); }
  async search(query: string, signal: AbortSignal): Promise<{ matches: HomeSearchMatch[]; count: number; failed: number }> {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const matches: HomeSearchMatch[] = [];
    let failed = 0;
    const files = this.app.vault.getMarkdownFiles().filter((file) => this.includeNotePath(file.path));
    const paths = new Set(files.map((f) => f.path));
    for (const cache of [this.cache, this.contentCache]) for (const p of cache.keys()) if (!paths.has(p)) cache.delete(p);
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) return { matches: [], count: 0, failed: 0 };
      const file = files[i];
      try {
        let cached = this.cache.get(file.path);
        if (!cached || cached.mtime !== file.stat.mtime) {
          const metadata = this.app.metadataCache.getFileCache(file);
          const frontmatter = metadata?.frontmatter;
          const text = [file.path, file.basename, frontmatter?.aliases, frontmatter?.alias, frontmatter?.tags, ...(metadata?.tags ?? []).map((tag) => tag.tag)]
            .flat().filter((v) => typeof v === "string").join(" ").toLocaleLowerCase();
          cached = { mtime: file.stat.mtime, text };
          this.cache.set(file.path, cached);
        }
        let searchable = cached.text;
        if (terms.length && !terms.every((t) => searchable.includes(t))) {
          let content = this.contentCache.get(file.path);
          if (!content || content.mtime !== file.stat.mtime) {
            if (signal.aborted) return { matches: [], count: 0, failed: 0 };
            content = { mtime: file.stat.mtime, text: await this.app.vault.cachedRead(file) };
            if (signal.aborted) return { matches: [], count: 0, failed: 0 };
            this.contentCache.set(file.path, content);
          }
          searchable += " " + content.text.toLocaleLowerCase();
        }
        if (terms.every((t) => searchable.includes(t))) matches.push({ path: file.path, title: file.basename, mtime: file.stat.mtime, snippet: "" });
      } catch { failed++; }
      if (i % 100 === 99) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    const visible = matches.slice(0, 6);
    for (const match of visible) {
      if (signal.aborted) return { matches: [], count: 0, failed: 0 };
      const file = files.find((item) => item.path === match.path)!;
      try {
        let content = this.contentCache.get(file.path);
        if (!content || content.mtime !== file.stat.mtime) {
          content = { mtime: file.stat.mtime, text: await this.app.vault.cachedRead(file) };
          if (signal.aborted) return { matches: [], count: 0, failed: 0 };
          this.contentCache.set(file.path, content);
        }
        const text = plainExcerpt(content.text);
        const lower = text.toLocaleLowerCase();
        const phrase = terms.length ? lower.indexOf(terms.join(" ")) : -1;
        const anchor = phrase >= 0 ? phrase : [...terms].sort((a, b) => b.length - a.length).map((term) => lower.indexOf(term)).find((position) => position >= 0) ?? 0;
        const start = Math.max(0, anchor - 45);
        match.snippet = `${start ? "…" : ""}${text.slice(start, start + 150)}${text.length > start + 150 ? "…" : ""}`;
      } catch { failed++; }
    }
    return { matches: visible, count: matches.length, failed };
  }
  async excerpt(path: string): Promise<string> {
    if (!this.includeNotePath(path)) return "";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.stat.size > 262_144) return "";
    const text = await this.app.vault.cachedRead(file);
    return plainExcerpt(text).slice(0, 150);
  }
}

function plainExcerpt(text: string): string {
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u, "").replace(/[#>*_`[\]]/gu, "").replace(/\s+/gu, " ").trim();
}
