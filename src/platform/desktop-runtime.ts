import { Platform } from "obsidian";

declare const require: (id: string) => unknown;

export function getDesktopUtil(): typeof import("node:util") {
  if (!Platform.isDesktop) throw new Error("Node utilities require desktop Obsidian.");
  return require("node:util") as typeof import("node:util");
}

export function getDesktopBuffer(): typeof import("node:buffer") {
  if (!Platform.isDesktop) throw new Error("Node buffers require desktop Obsidian.");
  return require("node:buffer") as typeof import("node:buffer");
}

export function getDesktopModule(): typeof import("node:module") {
  if (!Platform.isDesktop) throw new Error("Local module loading requires desktop Obsidian.");
  return require("node:module") as typeof import("node:module");
}
