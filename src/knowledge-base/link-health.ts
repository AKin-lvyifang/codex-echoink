import { TFolder, type App, type EventRef } from "obsidian";
import { classifyKnowledgePath, type KnowledgeFolderBindings } from "./folder-bindings";

export interface KnowledgeLinkHealth {
  state: "ready" | "unknown";
  candidatePaths: string[];
  isolatedPaths: string[];
  reason?: string;
}

/** All edges come from Obsidian's full-Vault resolver; only the candidates are scoped. */
export class KnowledgeLinkHealthService {
  private resolved = false;
  private invalidated = false;
  private readonly refs: EventRef[];
  constructor(private readonly app: App) {
    this.refs = [app.metadataCache.on("resolved", () => { this.resolved = true; this.invalidated = false; }),
      app.metadataCache.on("changed", () => { this.resolved = false; this.invalidated = true; }),
      app.metadataCache.on("deleted", () => { this.resolved = false; this.invalidated = true; })];
  }
  dispose(): void { for (const ref of this.refs) this.app.metadataCache.offref(ref); }
  async load(bindings: KnowledgeFolderBindings): Promise<KnowledgeLinkHealth> {
    const files = this.app.vault.getMarkdownFiles();
    const candidates = [...new Set(files.filter(file => {
      const role = classifyKnowledgePath(bindings, file.path);
      return (role === "wiki" || role === "projects") && !file.path.split("/").some(part => part.startsWith("."));
    }).map(file => file.path))].sort();
    const cache = this.app.metadataCache;
    const links = cache.resolvedLinks;
    // A populated, complete per-file graph also supports opening the workbench after the resolved event.
    const complete = links && files.every(file => Object.hasOwn(links, file.path) && cache.getFileCache(file) !== null);
    if (this.invalidated || (!this.resolved && !complete) || !links || !this.app.workspace.layoutReady) return { state: "unknown", candidatePaths: candidates, isolatedPaths: [], reason: "笔记链接仍在解析" };
    const markdown = new Set(files.map(file => file.path)), connected = new Set<string>();
    let batch = 0;
    for (const [source, destinations] of Object.entries(links)) {
      if (!markdown.has(source)) continue;
      for (const [target, count] of Object.entries(destinations)) if (count > 0 && target !== source && markdown.has(target)) {
        connected.add(source); connected.add(target);
      }
      if (++batch % 200 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    return { state: "ready", candidatePaths: candidates, isolatedPaths: candidates.filter(file => !connected.has(file)) };
  }
}

export function validWorkbenchBindingRoots(app: App, bindings: KnowledgeFolderBindings, role: keyof KnowledgeFolderBindings["roles"]): string[] {
  const binding = bindings.roles[role];
  return binding.enabled ? binding.readPaths.filter(root => app.vault.getAbstractFileByPath(root) instanceof TFolder) : [];
}
