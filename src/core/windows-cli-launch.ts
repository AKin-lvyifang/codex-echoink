import * as path from "path";

export interface SafeCliLaunch {
  command: string;
  argsPrefix: string[];
  resolvedPath: string;
}

export type CliPathExists = (candidate: string) => boolean;

const WINDOWS_POWERSHELL_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] as const;

export function windowsPowerShellScriptLaunch(scriptPath: string, systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows"): SafeCliLaunch {
  return {
    command: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    argsPrefix: [...WINDOWS_POWERSHELL_FLAGS, scriptPath],
    resolvedPath: scriptPath
  };
}

export function resolveWindowsNpmLaunch(input: {
  envPath: string;
  exists: CliPathExists;
  programFiles?: string;
  systemRoot?: string;
}): SafeCliLaunch | null {
  const candidates = [
    ...splitWindowsPath(input.envPath).map((directory) => path.win32.join(directory, "npm.ps1")),
    path.win32.join(input.programFiles || process.env.ProgramFiles || "C:\\Program Files", "nodejs", "npm.ps1")
  ];
  const script = firstExistingWindowsPath(candidates, input.exists);
  if (!script || !path.win32.isAbsolute(script)) return null;
  const launch = windowsPowerShellScriptLaunch(script, input.systemRoot);
  return input.exists(launch.command) ? launch : null;
}

export function windowsOpenCodeNativeCandidates(prefix: string, arch: string = process.arch): string[] {
  const packageNames = arch === "arm64"
    ? ["opencode-windows-arm64"]
    : arch === "x64"
      ? ["opencode-windows-x64", "opencode-windows-x64-baseline"]
      : [];
  return uniqueWindowsPaths([
    path.win32.join(prefix, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    ...packageNames.map((packageName) => path.win32.join(prefix, "node_modules", packageName, "bin", "opencode.exe")),
    ...packageNames.map((packageName) => path.win32.join(prefix, "node_modules", "opencode-ai", "node_modules", packageName, "bin", "opencode.exe"))
  ]);
}

export function resolveWindowsOpenCodeLaunch(candidate: string, exists: CliPathExists, systemRoot?: string, arch: string = process.arch): SafeCliLaunch | null {
  if (!path.win32.isAbsolute(candidate)) return null;
  const extension = path.win32.extname(candidate).toLowerCase();
  if (extension === ".exe" && exists(candidate)) return { command: candidate, argsPrefix: [], resolvedPath: candidate };

  if (extension !== ".cmd" && extension !== ".ps1") return null;
  const script = extension === ".ps1" ? candidate : replaceWindowsExtension(candidate, ".ps1");
  if (exists(script)) {
    const launch = windowsPowerShellScriptLaunch(script, systemRoot);
    if (exists(launch.command)) return launch;
  }

  const prefixes = windowsShimPrefixes(candidate);
  const native = firstExistingWindowsPath(prefixes.flatMap((prefix) => windowsOpenCodeNativeCandidates(prefix, arch)), exists);
  if (native) return { command: native, argsPrefix: [], resolvedPath: native };
  return null;
}

export function windowsCodexNativeCandidates(prefix: string, arch: string = process.arch): string[] {
  const target = codexWindowsTarget(arch);
  if (!target) return [];
  const packageRoots = [
    path.win32.join(prefix, "node_modules", target.packageName),
    path.win32.join(prefix, "node_modules", "@openai", "codex", "node_modules", target.packageName)
  ];
  return uniqueWindowsPaths(packageRoots.flatMap((packageRoot) => [
    path.win32.join(packageRoot, "vendor", target.triple, "bin", "codex.exe"),
    path.win32.join(packageRoot, "vendor", target.triple, "codex", "codex.exe")
  ]));
}

export function resolveWindowsCodexCommand(candidate: string, exists: CliPathExists, arch: string = process.arch): string | null {
  if (!path.win32.isAbsolute(candidate)) return null;
  const extension = path.win32.extname(candidate).toLowerCase();
  if (extension === ".exe" && exists(candidate)) return candidate;
  if (extension !== ".cmd" && extension !== ".ps1") return null;
  return firstExistingWindowsPath(windowsShimPrefixes(candidate).flatMap((prefix) => windowsCodexNativeCandidates(prefix, arch)), exists);
}

export function splitWindowsPath(value: string): string[] {
  return String(value || "")
    .split(";")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function windowsShimPrefixes(shim: string): string[] {
  const directory = path.win32.dirname(shim);
  const baseName = path.win32.basename(directory).toLowerCase();
  const prefixes = [directory];
  if (baseName === "bin") prefixes.push(path.win32.dirname(directory));
  if (baseName === ".bin" && path.win32.basename(path.win32.dirname(directory)).toLowerCase() === "node_modules") {
    prefixes.push(path.win32.dirname(path.win32.dirname(directory)));
  }
  return uniqueWindowsPaths(prefixes);
}

function codexWindowsTarget(arch: string): { packageName: string; triple: string } | null {
  if (arch === "x64") return { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  if (arch === "arm64") return { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" };
  return null;
}

function replaceWindowsExtension(value: string, extension: string): string {
  return value.slice(0, value.length - path.win32.extname(value).length) + extension;
}

function firstExistingWindowsPath(candidates: string[], exists: CliPathExists): string | null {
  return uniqueWindowsPaths(candidates).find((candidate) => exists(candidate)) ?? null;
}

function uniqueWindowsPaths(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
