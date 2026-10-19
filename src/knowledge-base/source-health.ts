import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { classifyKnowledgePath, normalizeKnowledgeDirectory, pathInKnowledgeDirectory, type KnowledgeFolderBindings } from "./folder-bindings";
import { extractMachineSourceMarkers } from "./knowledge-maintenance-protocol";

export interface KnowledgeMissingSource {
  path: string;
  sourcePaths: string[];
}
export interface KnowledgeSourceHealth {
  state: "ready" | "partial" | "unknown";
  missing: KnowledgeMissingSource[];
  unknownCount: number;
  checkedCount: number;
}

/** Never follow a symbolic link, including one in a parent directory. */
export async function knowledgePagePathStat(vaultPath: string, relativePath: string): Promise<import("node:fs").Stats> {
  const normalized = normalizeKnowledgeDirectory(relativePath);
  let full = vaultPath;
  let stat: import("node:fs").Stats | undefined;
  for (const segment of normalized.split("/")) {
    full = path.join(full, segment);
    stat = await fsp.lstat(full);
    if (stat.isSymbolicLink()) throw new Error("位置包含符号链接，暂无法核实。");
  }
  return stat!;
}

export async function loadKnowledgeSourceHealth(vaultPath: string, bindings: KnowledgeFolderBindings, wikiPaths: readonly string[]): Promise<KnowledgeSourceHealth> {
  const validRawRoots: string[] = [];
  if (bindings.roles.raw.enabled) for (const root of bindings.roles.raw.readPaths) {
    try { if ((await knowledgePagePathStat(vaultPath, root)).isDirectory()) validRawRoots.push(root); } catch { /* Unavailable roots cannot prove a missing source. */ }
  }
  const missing: KnowledgeMissingSource[] = [];
  let unknownCount = 0, checkedCount = 0, batch = 0;
  for (const wikiPath of new Set(wikiPaths)) {
    const sourcePaths = new Set<string>();
    let known = false, unknown = false;
    try {
      if (classifyKnowledgePath(bindings, wikiPath) !== "wiki" || !(await knowledgePagePathStat(vaultPath, wikiPath)).isFile()) throw new Error("知识成果位置不可用");
      const text = await fsp.readFile(path.join(vaultPath, wikiPath), "utf8");
      // Parse the whole note before checking files: any malformed/conflicting marker makes it unknown.
      const markers = Array.from(extractMachineSourceMarkers(text), ([vaultRelativePath, contentRevision]) => ({ vaultRelativePath, contentRevision }));
      if (!markers.length) unknown = true;
      for (const marker of markers) {
        const roots = validRawRoots.filter(root => pathInKnowledgeDirectory(marker.vaultRelativePath, root));
        if (classifyKnowledgePath(bindings, marker.vaultRelativePath) !== "raw" || !roots.length) { unknown = true; continue; }
        try {
          const stat = await knowledgePagePathStat(vaultPath, marker.vaultRelativePath);
          if (stat.isFile()) known = true; // A changed revision is still present, never missing.
          else unknown = true;
        } catch (error) {
          // Only ENOENT under a still-readable, still-bound source root is evidence.
          let rootStillPresent = false;
          if ((error as NodeJS.ErrnoException).code === "ENOENT") for (const root of roots) {
            try { if ((await knowledgePagePathStat(vaultPath, root)).isDirectory()) rootStillPresent = true; } catch { /* Unknown. */ }
          }
          if (rootStillPresent) { known = true; sourcePaths.add(marker.vaultRelativePath); }
          else unknown = true;
        }
      }
    } catch { unknown = true; }
    if (known) checkedCount++;
    if (unknown || !known) unknownCount++;
    if (sourcePaths.size) missing.push({ path: wikiPath, sourcePaths: [...sourcePaths].sort() });
    if (++batch % 25 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return { state: !checkedCount && unknownCount ? "unknown" : unknownCount ? "partial" : "ready", missing, unknownCount, checkedCount };
}
