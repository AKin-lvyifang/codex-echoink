import type { DataAdapter } from "obsidian";
import { classifyKnowledgePath, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgePageDirectory, KnowledgePageDirectoryRole, KnowledgePageDirectoryRoot, PageFile } from "../home/knowledge-page-core";
import { strictKnowledgePagePath } from "./knowledge-page-paths";

export interface KnowledgePageFile extends PageFile { size: number }
export interface KnowledgePageScan { directory: KnowledgePageDirectory; files: KnowledgePageFile[] }
const rawExtensions = /\.(?:md|markdown|txt|pdf|docx|png|jpg|jpeg|webp|gif)$/iu;
const markdown = /\.(?:md|markdown)$/iu;
export const pagePathWithin = (path: string, root: string): boolean => path === root || path.startsWith(root + "/");
export async function scanKnowledgePageRole(adapter: DataAdapter, bindings: KnowledgeFolderBindings, role: KnowledgePageDirectoryRole, check: () => void): Promise<KnowledgePageScan> {
  const binding = bindings.roles[role], unit = ({ raw: "份", wiki: "篇", projects: "个", inbox: "条" } as const)[role];
  const roots: KnowledgePageDirectoryRoot[] = [], files = new Map<string, KnowledgePageFile>(), counted = new Set<string>();
  if (!binding.enabled || !binding.readPaths.length) return { directory: { role, unit, state: binding.enabled ? "unbound" : "disabled", count: null, latestMtime: 0, roots }, files: [] };
  let batch = 0;
  for (const savedRoot of new Set(binding.readPaths)) {
    check();
    const root: KnowledgePageDirectoryRoot = { path: savedRoot, state: "ready", count: null, latestMtime: 0 }; roots.push(root);
    try {
      strictKnowledgePagePath(savedRoot);
      const stat = await adapter.stat(savedRoot); check();
      if (!stat || stat.type !== "folder") { root.state = "invalid"; root.error = "位置已失效"; continue; }
    } catch (error) { check(); root.state = error instanceof Error && error.message.includes("相对路径") ? "invalid" : "unavailable"; root.error = "目录暂时无法读取"; continue; }
    root.count = 0;
    const pending = [savedRoot];
    while (pending.length) {
      check(); const current = pending.pop()!;
      try {
        const listed = await adapter.list(current); check();
        for (const child of listed.folders) {
          if (child.split("/").some(part => part.startsWith("."))) continue;
          strictKnowledgePagePath(child);
          if (!pagePathWithin(child, current) || child === current) throw new Error("目录清单已变化");
          pending.push(child);
          if (role === "projects" && current === savedRoot) { root.count++; counted.add(child); }
        }
        for (const child of listed.files) {
          check();
          if (child.split("/").some(part => part.startsWith("."))) continue;
          strictKnowledgePagePath(child);
          if (!pagePathWithin(child, current) || child === current) throw new Error("目录清单已变化");
          if (role !== "projects" && (classifyKnowledgePath(bindings, child) !== role || !(role === "raw" ? rawExtensions : markdown).test(child))) continue;
          try {
            const stat = await adapter.stat(child); check();
            if (!stat || stat.type !== "file") throw new Error("文件位置已变化");
            const mtime = Number.isFinite(stat.mtime) && stat.mtime > 0 ? stat.mtime : 0;
            files.set(child, { path: child, size: stat.size, mtime,
              birthtime: Number.isFinite(stat.ctime) && stat.ctime > 0 ? stat.ctime : null });
            root.latestMtime = Math.max(root.latestMtime, mtime);
            if (role !== "projects") { root.count++; counted.add(child); }
          } catch { check(); root.state = "partial"; root.error = "部分文件尚未读取"; }
          if (++batch % 100 === 0) { await new Promise<void>(resolve => window.setTimeout(resolve, 0)); check(); }
        }
      } catch { check(); root.state = "partial"; root.error = "部分目录尚未读取"; }
    }
  }
  const complete = roots.every(root => root.state === "ready"), readable = roots.some(root => root.count !== null);
  return { directory: { role, unit, roots, state: complete ? "ready" : readable ? "partial" : roots.some(root => root.state === "unavailable") ? "unavailable" : "invalid",
    count: complete ? counted.size : null, latestMtime: Math.max(0, ...roots.map(root => root.latestMtime)) }, files: [...files.values()] };
}
