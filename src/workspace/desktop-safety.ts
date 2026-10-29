import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";
import { WorkspaceError, workspacePath, type WorkspacePathGuard } from "./service";

/** Import this module only from the desktop host, never the mobile entry. */
export function createDesktopWorkspacePathGuard(vaultRoot: string): WorkspacePathGuard {
  const fs = getDesktopFsPromises(), path = getDesktopPath();
  const requestedRoot = path.resolve(vaultRoot);
  let pinnedRoot: string | undefined;
  const unsafe = () => new WorkspaceError("unsafe_path", "工作区路径经过符号链接或已离开当前笔记库，未访问文件。");
  return async (value, guard) => {
    const relative = workspacePath(value);
    const boundary = async <T>(action: () => Promise<T>): Promise<T> => { guard(); const result = await action(); guard(); return result; };
    const stat = async (target: string) => {
      try { return await boundary(() => fs.lstat(target)); }
      catch (error) { guard(); if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
    };
    const rootStat = await stat(requestedRoot);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw unsafe();
    const canonicalRoot = await boundary(() => fs.realpath(requestedRoot));
    if (pinnedRoot !== undefined && canonicalRoot !== pinnedRoot) throw unsafe();
    pinnedRoot = canonicalRoot;
    const segments = relative.split("/");
    let cursor = requestedRoot;
    for (let index = 0; index < segments.length; index++) {
      cursor = path.join(cursor, segments[index]);
      const before = await stat(cursor);
      if (!before) { guard(); return; } // Creation may introduce this absent suffix.
      if (before.isSymbolicLink() || (index < segments.length - 1 ? !before.isDirectory() : !before.isFile())) throw unsafe();
      const canonical = await boundary(() => fs.realpath(cursor));
      const inside = path.relative(canonicalRoot, canonical);
      if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
        || canonical !== path.join(canonicalRoot, ...segments.slice(0, index + 1))) throw unsafe();
      // Reject an entry replaced while its canonical path was being checked.
      const after = await stat(cursor);
      if (!after || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw unsafe();
    }
    guard();
  };
}
