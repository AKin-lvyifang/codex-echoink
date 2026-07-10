import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface HermesCommandResolveOptions {
  home?: string;
  envPath?: string;
  platform?: NodeJS.Platform | string;
  appData?: string;
  exists?: (candidate: string) => boolean;
}

export interface HermesVersionInfo {
  version: string;
  upstream: string;
}

export function resolveHermesCommand(customPath: string, options: HermesCommandResolveOptions = {}): string {
  const command = detectHermesCommand(customPath, options);
  if (command) return command;
  const requested = customPath.trim();
  if (requested) throw new Error(`找不到 Hermes CLI：${expandHome(requested, options.home ?? os.homedir())}`);
  throw new Error("找不到 Hermes CLI。请先安装 Hermes，或在设置里填写正确路径。");
}

export function detectHermesCommand(customPath: string, options: HermesCommandResolveOptions = {}): string | null {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const envPath = typeof options.envPath === "string" ? options.envPath : process.env.PATH ?? "";
  const candidates = customPath.trim()
    ? [expandHome(customPath.trim(), home)]
    : hermesCommandCandidates(home, platform, envPath, options.appData);
  return candidates.find((candidate) => candidate && exists(candidate)) ?? null;
}

export function normalizeHermesServerUrl(serverUrl: string, hostname: string, port: number): string {
  const base = serverUrl.trim()
    ? serverUrl.trim().replace(/\/+$/, "")
    : `http://${hostname || "127.0.0.1"}:${port || 8642}`;
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

export function parseHermesVersion(output: string): HermesVersionInfo {
  const version = output.match(/Hermes Agent v?([0-9]+(?:\.[0-9]+){1,3})/i)?.[1] ?? "";
  const upstream = output.match(/upstream\s+([a-f0-9]{7,40})/i)?.[1] ?? "";
  return { version, upstream };
}

export function isSyntheticHermesDefaultModel(providerId: string, modelId: string): boolean {
  return providerId.trim() === "hermes" && modelId.trim() === "hermes-agent";
}

function hermesCommandCandidates(home: string, platform: NodeJS.Platform | string, envPath: string, appData?: string): string[] {
  const pathCandidates = envPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((part) => path.join(part, platform === "win32" ? "hermes.exe" : "hermes"));
  if (platform === "win32") {
    const roaming = appData || path.win32.join(home, "AppData", "Roaming");
    return [
      ...pathCandidates,
      path.win32.join(roaming, "Python", "Scripts", "hermes.exe"),
      path.win32.join(roaming, "npm", "hermes.cmd"),
      path.win32.join(home, ".local", "bin", "hermes.exe")
    ];
  }
  return [
    ...pathCandidates,
    path.join(home, ".local", "bin", "hermes"),
    path.join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes"
  ];
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}
