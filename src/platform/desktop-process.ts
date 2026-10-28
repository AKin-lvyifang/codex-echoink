import { Platform } from "obsidian";

declare const require: (id: string) => unknown;

export function getDesktopChildProcess(): typeof import("node:child_process") {
  if (!Platform.isDesktop) throw new Error("Local processes require desktop Obsidian.");
  return require("node:child_process") as typeof import("node:child_process");
}
