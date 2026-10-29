import { Platform } from "obsidian";

declare const require: (id: string) => unknown;

export function getDesktopPath(): typeof import("node:path") {
  if (!Platform.isDesktop) throw new Error("Node paths require desktop Obsidian.");
  return require("node:path") as typeof import("node:path");
}

export function getDesktopOs(): typeof import("node:os") {
  if (!Platform.isDesktop) throw new Error("System directories require desktop Obsidian.");
  return require("node:os") as typeof import("node:os");
}

export function getDesktopUrl(): typeof import("node:url") {
  if (!Platform.isDesktop) throw new Error("Node URL conversion requires desktop Obsidian.");
  return require("node:url") as typeof import("node:url");
}
