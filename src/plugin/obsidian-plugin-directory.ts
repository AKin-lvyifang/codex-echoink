import { requestUrl } from "obsidian";
export const OBSIDIAN_PLUGIN_DIRECTORY_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
export interface ObsidianCommunityPlugin { id: string; name: string; author: string; description: string; repo: string }
export class ObsidianPluginDirectory {
  private cached?: { at: number; entries: readonly ObsidianCommunityPlugin[] };
  constructor(private readonly load: () => Promise<unknown> = async () => {
    const response = await requestUrl({ url: OBSIDIAN_PLUGIN_DIRECTORY_URL, method: "GET", throw: false });
    if (response.status !== 200 || response.text.length > 4_000_000) throw new Error("obsidian_plugin_directory_unavailable");
    return JSON.parse(response.text) as unknown;
  }) {}
  async entries(signal?: AbortSignal): Promise<readonly ObsidianCommunityPlugin[]> {
    if (signal?.aborted) throw new Error("obsidian_plugin_search_cancelled");
    if (this.cached && Date.now() - this.cached.at < 300_000) return this.cached.entries;
    const raw = await this.load();
    if (signal?.aborted) throw new Error("obsidian_plugin_search_cancelled");
    if (!Array.isArray(raw) || raw.length > 30_000) throw new Error("obsidian_plugin_directory_invalid");
    const entries: ObsidianCommunityPlugin[] = [];
    const ids = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(entry.id) || ids.has(entry.id)
        || !["name", "author", "description", "repo"].every(key => typeof entry[key] === "string") || !/^[\w.-]+\/[\w.-]+$/u.test(entry.repo)) throw new Error("obsidian_plugin_directory_invalid");
      ids.add(entry.id);
      entries.push(Object.freeze({ id: entry.id, name: entry.name, author: entry.author, description: entry.description, repo: entry.repo }));
    }
    this.cached = { at: Date.now(), entries: Object.freeze(entries) };
    return this.cached.entries;
  }
  async find(id: string, signal?: AbortSignal): Promise<ObsidianCommunityPlugin> {
    const plugin = (await this.entries(signal)).find(entry => entry.id === id);
    if (!plugin) throw new Error("obsidian_plugin_not_in_official_directory");
    return plugin;
  }
  async search(query: string, limit: number, signal?: AbortSignal) {
    const words = query.trim().toLocaleLowerCase().split(/\s+/u);
    const matches = (await this.entries(signal)).filter(entry => words.every(word => `${entry.id} ${entry.name} ${entry.description} ${entry.author}`.toLocaleLowerCase().includes(word)));
    return { status: matches.length ? "completed" : "empty", source: OBSIDIAN_PLUGIN_DIRECTORY_URL, count: matches.length, plugins: matches.slice(0, limit).map(entry => ({ ...entry, repository: `https://github.com/${entry.repo}` })), truncated: matches.length > limit, installedList: false };
  }
}
