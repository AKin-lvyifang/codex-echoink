import { readdirSync, lstatSync } from "node:fs";
import * as path from "node:path";

import { KNOWLEDGE_ROOT_NAMES, knowledgeRootRole, resolveKnowledgePathFromRoots, type KnowledgeRootRole } from "./root-paths-core";
export * from "./root-paths-core";

export function knowledgeRootEntries(vaultRoot: string): string[] {
  try { return readdirSync(vaultRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function resolveKnowledgePath(vaultRoot: string, relativePath: string, preferBilingual = true): string {
  return resolveKnowledgePathFromRoots(relativePath, knowledgeRootEntries(vaultRoot), preferBilingual);
}

export function knowledgeRoleRoots(vaultRoot: string, role: KnowledgeRootRole): string[] {
  const matches = knowledgeRootEntries(vaultRoot).filter((root) => {
    if (knowledgeRootRole(root) !== role) return false;
    try {
      const stat = lstatSync(path.join(vaultRoot, root));
      // Keep symlinks visible to each caller's existing safety checks.
      return stat.isDirectory() || stat.isSymbolicLink();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
  return matches.length ? matches : [KNOWLEDGE_ROOT_NAMES[role]];
}
