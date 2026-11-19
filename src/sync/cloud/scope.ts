import { SYNC_DEVICES_DIR, SYNC_ROOT } from "../types";

export interface CloudSyncScope {
  readonly excludedFolders: readonly string[];
  readonly includeAttachments: boolean;
}
export const isCloudText = (path: string): boolean => /\.(?:md|txt|json|jsonl|canvas|base|csv)$/iu.test(path);
export const isMergeableCloudText = (path: string): boolean => /\.(?:md|txt)$/iu.test(path);
export const isCloudConflict = (path: string): boolean => /\(冲突 [^)]*\)(?: \d+)?(?:\.[^./]+)?$/u.test(path);
// These are migration backups/identity, not user-visible note outputs. Other EchoInk content is included.
const INTERNAL = ["EchoInk/待办-settings-backup.json", "vault-identity.json", "vault-identity-backups", "mobile-memory-migration.json"];
const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);
export function cloudPathAllowed(path: string, ignoredRoots: readonly string[] = []): boolean {
  return !!path && !path.startsWith("/") && !path.includes("\\") && !/\p{Cc}/u.test(path)
    && path.split("/").every(part => !!part && !part.startsWith("."))
    && !isCloudConflict(path) && ![...ignoredRoots, ...INTERNAL].some(root => root && under(path, root));
}
export function cloudPathInScope(path: string, scope: CloudSyncScope, ownMirror: string, ignoredRoots: readonly string[] = []): boolean {
  if (!cloudPathAllowed(path, ignoredRoots)) return false;
  if (under(path, ownMirror)) return true;
  if (under(path, SYNC_ROOT)) return false;
  return !cloudFolderExcludedBy(path, scope.excludedFolders) && (scope.includeAttachments || isCloudText(path));
}
export function cloudPathReceivable(path: string, scope: CloudSyncScope, ownMirror: string, ignoredRoots: readonly string[] = []): boolean {
  if (!cloudPathAllowed(path, ignoredRoots)) return false;
  if (path.startsWith(`${SYNC_DEVICES_DIR}/`)) return !under(path, ownMirror);
  return cloudPathInScope(path, scope, ownMirror, ignoredRoots);
}
/** An exclusion covers the folder itself and everything below it. Returns the covering rule, if any. */
export function cloudFolderExcludedBy(path: string, excludedFolders: readonly string[]): string | undefined {
  // Runs for every path the engine scans; the usual case is an empty list.
  if (!excludedFolders.length) return undefined;
  for (const root of excludedFolders) if (under(path, root)) return root;
  return undefined;
}
/** checked = synced; mixed = synced, with excluded folders somewhere below. */
export function cloudFolderState(path: string, excludedFolders: readonly string[]): "true" | "false" | "mixed" {
  if (cloudFolderExcludedBy(path, excludedFolders)) return "false";
  return excludedFolders.some(root => root !== path && under(root, path)) ? "mixed" : "true";
}
/** Whether a folder may be offered as a sync choice at all. */
export function cloudFolderSelectable(path: string, ignoredRoots: readonly string[] = []): boolean {
  return cloudPathAllowed(path, ignoredRoots) && !under(path, SYNC_ROOT);
}
/**
 * One click on a folder. Synced → excluded; partly synced → fully synced again;
 * excluded → only this branch returns, its siblings stay excluded.
 * `childrenOf` lists direct child folders; it is consulted only when re-including below an excluded folder.
 */
export async function toggleCloudFolder(path: string, excludedFolders: readonly string[], childrenOf: (folder: string) => Promise<readonly string[]>): Promise<string[]> {
  const rule = cloudFolderExcludedBy(path, excludedFolders);
  if (!rule) {
    const partial = cloudFolderState(path, excludedFolders) === "mixed";
    const next = excludedFolders.filter(root => !under(root, path));
    return partial ? next : [...next, path];
  }
  const next = new Set(excludedFolders); next.delete(rule);
  for (let at = rule; at !== path;) {
    const step = path.slice(0, path.indexOf("/", at.length + 1) < 0 ? path.length : path.indexOf("/", at.length + 1));
    for (const child of await childrenOf(at)) if (child !== step) next.add(child);
    at = step;
  }
  return [...next];
}
/** Direct child folders to show under `parent` ("" = vault root), including excluded ones missing on this device. */
export function cloudFolderChildren(parent: string, localFolders: readonly string[], excludedFolders: readonly string[], ignoredRoots: readonly string[] = []): string[] {
  const direct = (path: string) => parent ? path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes("/") : !path.includes("/");
  return [...new Set([...localFolders, ...excludedFolders])].filter(path => direct(path) && cloudFolderSelectable(path, ignoredRoots)).sort((a, b) => a.localeCompare(b));
}
export function cloudFolderChoices(localFolders: readonly string[], excludedFolders: readonly string[], ignoredRoots: readonly string[] = []): string[] {
  return [...new Set([...localFolders, ...excludedFolders])].filter(name => !name.includes("/") && cloudPathAllowed(name, ignoredRoots)).sort((a, b) => a.localeCompare(b));
}
