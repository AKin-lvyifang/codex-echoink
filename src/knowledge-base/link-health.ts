import { scanKnowledgeStructure } from "./knowledge-structure-scan";
import { TFolder, type App, type EventRef } from "obsidian";
import { type KnowledgeFolderBindings } from "./folder-bindings";

export interface KnowledgeLinkHealth {
  state: "ready" | "unknown";
  candidatePaths: string[];
  isolatedPaths: string[];
  reason?: string;
}

/** Use Obsidian's resolver; only active, general Wiki-to-Wiki edges connect candidates. */
export class KnowledgeLinkHealthService {
  private invalidated = false;
  private resolved = false;
  private readonly refs: EventRef[];
  constructor(private readonly app: App) {
    this.refs = [
      app.metadataCache.on("resolved", () => {
        this.invalidated = false;
        this.resolved = true;
      }),
      app.metadataCache.on("changed", () => {
        this.invalidated = true;
      }),
      app.metadataCache.on("deleted", () => {
        this.invalidated = true;
      }),
    ];
  }
  dispose(): void {
    for (const ref of this.refs) this.app.metadataCache.offref(ref);
  }
  async load(bindings: KnowledgeFolderBindings): Promise<KnowledgeLinkHealth> {
    const scan = scanKnowledgeStructure(this.app, bindings);
    const graph = this.app.metadataCache.resolvedLinks;
    const complete = graph && scan.files.every((file) => Object.hasOwn(graph, file.path));
    const loading = scan.loading || this.invalidated || (!this.resolved && !complete);
    return {
      state: loading ? "unknown" : "ready",
      candidatePaths: scan.files.map((file) => file.path).sort(),
      isolatedPaths: loading
        ? []
        : scan.findings
            .filter((finding) => finding.kind === "isolated")
            .map((finding) => finding.path)
            .sort(),
      ...(loading ? { reason: "笔记链接仍在解析" } : {}),
    };
  }
}

export function validWorkbenchBindingRoots(
  app: App,
  bindings: KnowledgeFolderBindings,
  role: keyof KnowledgeFolderBindings["roles"],
): string[] {
  const binding = bindings.roles[role];
  return binding.enabled
    ? binding.readPaths.filter((root) => app.vault.getAbstractFileByPath(root) instanceof TFolder)
    : [];
}
