import { type App, TFile } from "obsidian";
import { isHomeNotePath, type HomeNoteVisibility } from "./home-note-visibility";

export interface HomeSearchMatch { path: string; title: string; mtime: number; snippet: string }
/** Metadata first, then on-demand content; new input cancels old work between reads. */
export class HomeSearchService {
  private readonly cache = new Map<string, { mtime: number; text: string }>();
  private readonly contentCache = new Map<string, { mtime: number; text: string }>();
  constructor(private readonly app: App, private readonly includeNotePath: HomeNoteVisibility = isHomeNotePath) {}
  async search(query: string, signal: AbortSignal): Promise<{ matches: HomeSearchMatch[]; count: number; failed: number }> {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const matches: HomeSearchMatch[] = [];
    let failed = 0;
    const files = this.app.vault.getMarkdownFiles().filter((file) => this.includeNotePath(file.path));
    const paths = new Set(files.map((f) => f.path));
    for (const p of this.cache.keys()) if (!paths.has(p)) { this.cache.delete(p); this.contentCache.delete(p); }
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
      if (i % 100 === 99) await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
