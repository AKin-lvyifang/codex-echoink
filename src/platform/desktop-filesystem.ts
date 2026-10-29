import { Platform } from "obsidian";

declare const require: (id: string) => unknown;

// Keep Node's synchronous, promise, watcher and durability APIs unchanged.
export function getDesktopFs(): typeof import("node:fs") {
  if (!Platform.isDesktop) throw new Error("Node filesystem access requires desktop Obsidian.");
  return require("node:fs") as typeof import("node:fs");
}

export function getDesktopFsPromises(): typeof import("node:fs/promises") {
  if (!Platform.isDesktop) throw new Error("Node filesystem access requires desktop Obsidian.");
  return require("node:fs/promises") as typeof import("node:fs/promises");
}
