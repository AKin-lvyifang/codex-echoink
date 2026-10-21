import { classifyKnowledgePath, pathInKnowledgeDirectory, type KnowledgeFolderBindings } from "./folder-bindings";

export interface KnowledgeMissingSource { path: string; sourcePaths: string[] }
export interface KnowledgeSourceHealth {
  state: "ready" | "partial" | "unknown";
  missing: KnowledgeMissingSource[]; unknownCount: number; checkedCount: number;
}
export interface KnowledgeSourceHealthPort {
  kind(path: string): Promise<"file" | "folder" | "missing" | "unknown">;
  read(path: string): Promise<string>;
  markers(content: string): Map<string, string>;
  assertActive?(): void;
}
/** Only an absent file beneath a still-readable bound source root proves missing. */
export async function loadKnowledgeSourceHealthCore(bindings: KnowledgeFolderBindings, wikiPaths: readonly string[], host: KnowledgeSourceHealthPort): Promise<KnowledgeSourceHealth> {
  const validRawRoots: string[] = [];
  if (bindings.roles.raw.enabled) for (const root of bindings.roles.raw.readPaths) {
    try { if (await host.kind(root) === "folder") validRawRoots.push(root); } catch { /* An unreadable root cannot prove absence. */ }
  }
  const missing: KnowledgeMissingSource[] = [];
  let unknownCount = 0, checkedCount = 0, batch = 0;
  for (const wikiPath of new Set(wikiPaths)) {
    host.assertActive?.();
    const sourcePaths = new Set<string>();
    let known = false, unknown = false;
    try {
      if (classifyKnowledgePath(bindings, wikiPath) !== "wiki" || await host.kind(wikiPath) !== "file") throw new Error("知识成果位置不可用");
      const markers = Array.from(host.markers(await host.read(wikiPath)), ([vaultRelativePath, contentRevision]) => ({ vaultRelativePath, contentRevision }));
      if (!markers.length) unknown = true;
      for (const marker of markers) {
        const roots = validRawRoots.filter(root => pathInKnowledgeDirectory(marker.vaultRelativePath, root));
        if (classifyKnowledgePath(bindings, marker.vaultRelativePath) !== "raw" || !roots.length) { unknown = true; continue; }
        const state = await host.kind(marker.vaultRelativePath);
        if (state === "file") known = true;
        else if (state === "missing") {
          let rootStillPresent = false;
          for (const root of roots) { try { if (await host.kind(root) === "folder") rootStillPresent = true; } catch { /* Unknown. */ } }
          if (rootStillPresent) { known = true; sourcePaths.add(marker.vaultRelativePath); } else unknown = true;
        } else unknown = true;
      }
    } catch { unknown = true; }
    if (known) checkedCount++;
    if (unknown || !known) unknownCount++;
    if (sourcePaths.size) missing.push({ path: wikiPath, sourcePaths: [...sourcePaths].sort() });
    host.assertActive?.();
    if (++batch % 25 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }
  return { state: !checkedCount && unknownCount ? "unknown" : unknownCount ? "partial" : "ready", missing, unknownCount, checkedCount };
}
