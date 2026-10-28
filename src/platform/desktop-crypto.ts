import { Platform } from "obsidian";

declare const require: (id: string) => unknown;

export function getDesktopCrypto(): typeof import("node:crypto") {
  if (!Platform.isDesktop) throw new Error("Node cryptography requires desktop Obsidian.");
  return require("node:crypto") as typeof import("node:crypto");
}
