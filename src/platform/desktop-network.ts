import { Platform } from "obsidian";

declare const require: (id: string) => unknown;

export function getDesktopHttp(): typeof import("node:http") {
  if (!Platform.isDesktop) throw new Error("Node HTTP transport requires desktop Obsidian.");
  return require("node:http") as typeof import("node:http");
}

export function getDesktopHttps(): typeof import("node:https") {
  if (!Platform.isDesktop) throw new Error("Node HTTPS transport requires desktop Obsidian.");
  return require("node:https") as typeof import("node:https");
}

export function getDesktopNet(): typeof import("node:net") {
  if (!Platform.isDesktop) throw new Error("Node network helpers require desktop Obsidian.");
  return require("node:net") as typeof import("node:net");
}
