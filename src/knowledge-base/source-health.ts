import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";

import { normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "./folder-bindings";
import { extractMachineSourceMarkers } from "./knowledge-maintenance-protocol";

export type { KnowledgeMissingSource, KnowledgeSourceHealth } from "./source-health-core";
import { loadKnowledgeSourceHealthCore, type KnowledgeSourceHealth } from "./source-health-core";

const fsp = getDesktopFsPromises();
const path = getDesktopPath();

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
  return loadKnowledgeSourceHealthCore(bindings, wikiPaths, {
    kind: async relative => {
      try { const stat = await knowledgePagePathStat(vaultPath, relative); return stat.isFile() ? "file" : stat.isDirectory() ? "folder" : "unknown"; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"; }
    },
    read: relative => fsp.readFile(path.join(vaultPath, relative), "utf8"),
    markers: extractMachineSourceMarkers
  });
}
