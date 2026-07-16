import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveWindowsNpmLaunch, resolveWindowsOpenCodeLaunch, windowsCodexNativeCandidates, windowsOpenCodeNativeCandidates } from "./windows-cli-launch";

export type NpmCliKind = "codex" | "opencode";
export type NpmCliInstallStatus = "installed" | "cancelled" | "failed";
export type NpmCliInstallErrorKind = "npm-missing" | "permission" | "timeout" | "failed" | "cli-missing";

export const CODEX_NPM_PACKAGE = "@openai/codex";
export const OPENCODE_NPM_PACKAGE = "opencode-ai";
export const OPENCODE_USER_PREFIX_DIRECTORY = ".npm-global";
export const CODEX_NPM_INSTALL_ARGS = ["install", "--global", CODEX_NPM_PACKAGE] as const;

export interface NpmCliInstallSpec {
  readonly kind: NpmCliKind;
  readonly packageName: typeof CODEX_NPM_PACKAGE | typeof OPENCODE_NPM_PACKAGE;
  readonly executableName: "codex" | "opencode";
  readonly userPrefix: boolean;
}

export const NPM_CLI_INSTALL_SPECS: Readonly<Record<NpmCliKind, NpmCliInstallSpec>> = Object.freeze({
  codex: Object.freeze({
    kind: "codex",
    packageName: CODEX_NPM_PACKAGE,
    executableName: "codex",
    userPrefix: false
  }),
  opencode: Object.freeze({
    kind: "opencode",
    packageName: OPENCODE_NPM_PACKAGE,
    executableName: "opencode",
    userPrefix: true
  })
});

export interface NpmCliRunnerOptions {
  shell: false;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export type NpmCliRunner = (
  command: string,
  args: readonly string[],
  options: NpmCliRunnerOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface NpmCliInstallOptions {
  home?: string;
  platform?: NodeJS.Platform | string;
  arch?: string;
  envPath?: string;
  programFiles?: string;
  systemRoot?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxLogChars?: number;
  exists?: (candidate: string) => boolean;
  runner?: NpmCliRunner;
}

export interface NpmCliInstallResult {
  status: NpmCliInstallStatus;
  kind: NpmCliKind;
  command: string | null;
  version: string | null;
  logs: string;
  errorKind?: NpmCliInstallErrorKind;
  error?: string;
}

export function npmCliUserPrefix(home: string, platform: string = process.platform): string {
  return platform === "win32"
    ? path.win32.join(home, OPENCODE_USER_PREFIX_DIRECTORY)
    : path.join(home, OPENCODE_USER_PREFIX_DIRECTORY);
}

export function npmCliInstallArgs(kind: NpmCliKind, home: string, platform: string = process.platform): readonly string[] {
  const spec = NPM_CLI_INSTALL_SPECS[kind];
  if (!spec.userPrefix) return CODEX_NPM_INSTALL_ARGS;
  return ["install", "--global", "--prefix", npmCliUserPrefix(home, platform), OPENCODE_NPM_PACKAGE] as const;
}

export function npmCliPrefixArgs(kind: NpmCliKind, home: string, platform: string = process.platform): readonly string[] {
  return kind === "opencode"
    ? ["prefix", "--global", "--prefix", npmCliUserPrefix(home, platform)] as const
    : ["prefix", "--global"] as const;
}

export async function installNpmCli(kind: NpmCliKind, options: NpmCliInstallOptions = {}): Promise<NpmCliInstallResult> {
  const spec = NPM_CLI_INSTALL_SPECS[kind];
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const runner = options.runner ?? execFileRunner;
  const exists = options.exists ?? fs.existsSync;
  const envPath = options.envPath ?? process.env.PATH ?? "";
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000);
  const maxLogChars = Math.max(256, options.maxLogChars ?? 8_000);
  const userPrefix = npmCliUserPrefix(home, platform);
  const prefixBin = platform === "win32" ? userPrefix : path.join(userPrefix, "bin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: [prefixBin, envPath].filter(Boolean).join(platform === "win32" ? ";" : path.delimiter)
  };
  const runnerOptions: NpmCliRunnerOptions = {
    shell: false,
    signal: options.signal,
    timeoutMs,
    maxBuffer: 1024 * 1024,
    env
  };

  try {
    const npmLaunch = platform === "win32"
      ? resolveWindowsNpmLaunch({
        envPath,
        exists,
        programFiles: options.programFiles,
        systemRoot: options.systemRoot
      })
      : { command: "npm", argsPrefix: [] as string[] };
    if (!npmLaunch) throw missingNpmError();
    const install = await runner(npmLaunch.command, [...npmLaunch.argsPrefix, ...npmCliInstallArgs(kind, home, platform)], runnerOptions);
    const prefix = await runner(npmLaunch.command, [...npmLaunch.argsPrefix, ...npmCliPrefixArgs(kind, home, platform)], runnerOptions);
    const command = installedNpmCliCommand(spec, prefix.stdout, platform, exists, options.arch ?? process.arch);
    if (!command) {
      return {
        status: "failed",
        kind,
        command: null,
        version: null,
        logs: limitedLogs(install, maxLogChars),
        errorKind: "cli-missing",
        error: `安装命令已结束，但没有找到 ${displayName(kind)} CLI。请打开终端重试。`
      };
    }
    const versionLaunch = platform === "win32" && kind === "opencode"
      ? resolveWindowsOpenCodeLaunch(command, exists, options.systemRoot, options.arch ?? process.arch)
      : { command, argsPrefix: [] as string[] };
    if (!versionLaunch) throw unsafeInstalledCliError(kind);
    const versionResult = await runner(versionLaunch.command, [...versionLaunch.argsPrefix, "--version"], { ...runnerOptions, timeoutMs: 10_000 });
    return {
      status: "installed",
      kind,
      command,
      version: firstNonEmptyLine(versionResult.stdout || versionResult.stderr),
      logs: limitedLogs(install, maxLogChars)
    };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      return { status: "cancelled", kind, command: null, version: null, logs: "", error: "安装已取消" };
    }
    const errorKind = npmInstallErrorKind(error);
    return {
      status: "failed",
      kind,
      command: null,
      version: null,
      logs: limitedText(error instanceof Error ? error.message : String(error), maxLogChars),
      errorKind,
      error: npmInstallErrorMessage(kind, errorKind, error)
    };
  }
}

export function installedNpmCliCommand(
  spec: Pick<NpmCliInstallSpec, "executableName">,
  prefixOutput: string,
  platform: string,
  exists: (candidate: string) => boolean = fs.existsSync,
  arch: string = process.arch
): string | null {
  const prefix = firstNonEmptyLine(prefixOutput);
  if (!prefix) return null;
  const candidates = platform === "win32"
    ? spec.executableName === "codex"
      ? windowsCodexNativeCandidates(prefix, arch)
      : [
        path.win32.join(prefix, "opencode.ps1"),
        path.win32.join(prefix, "bin", "opencode.ps1"),
        ...windowsOpenCodeNativeCandidates(prefix, arch)
      ]
    : [path.join(prefix, "bin", spec.executableName)];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

function missingNpmError(): Error & { code: string } {
  const error = new Error("没有找到可安全执行的 npm.ps1") as Error & { code: string };
  error.code = "ENOENT";
  return error;
}

function unsafeInstalledCliError(kind: NpmCliKind): Error {
  return new Error(`安装后的 ${displayName(kind)} CLI 无法通过安全启动器执行`);
}

function execFileRunner(command: string, args: readonly string[], options: NpmCliRunnerOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      shell: false,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: options.env
    }, (error, stdout, stderr) => {
      if (error) {
        const combined = [error.message, stderr].filter(Boolean).join("\n");
        const wrapped = new Error(combined) as Error & { code?: unknown; killed?: boolean; name: string };
        wrapped.code = (error as NodeJS.ErrnoException).code;
        wrapped.killed = (error as { killed?: boolean }).killed;
        wrapped.name = error.name;
        reject(wrapped);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function npmInstallErrorKind(error: unknown): NpmCliInstallErrorKind {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT") return "npm-missing";
  if (code === "EACCES" || code === "EPERM" || /EACCES|EPERM|permission denied/i.test(message)) return "permission";
  if ((error as { killed?: boolean } | null)?.killed || /timed?\s*out|timeout/i.test(message)) return "timeout";
  return "failed";
}

function npmInstallErrorMessage(kind: NpmCliKind, errorKind: NpmCliInstallErrorKind, error: unknown): string {
  if (errorKind === "npm-missing") return "没有找到 npm。请先安装 Node.js，再打开终端运行官方安装命令。";
  if (errorKind === "permission") return "npm 没有安装权限。EchoInk 不会使用 sudo；请打开终端按 npm 官方方式修复权限。";
  if (errorKind === "timeout") return "安装等待超时，请检查网络后重试。";
  const message = error instanceof Error ? error.message : String(error);
  return `${displayName(kind)} 安装失败：${limitedText(message, 400)}`;
}

function displayName(kind: NpmCliKind): string {
  return kind === "codex" ? "Codex" : "OpenCode";
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|aborterror/i.test(error.message));
}

function limitedLogs(result: { stdout: string; stderr: string }, maxChars: number): string {
  return limitedText([result.stdout, result.stderr].filter(Boolean).join("\n"), maxChars);
}

function limitedText(value: string, maxChars: number): string {
  const normalized = redactSensitiveText(String(value ?? "").trim());
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}\n…`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[已隐藏密钥]")
    .replace(/((?:api[_-]?key|authorization|token)\s*[:=]\s*)([^\s]+)/gi, "$1[已隐藏]");
}

function firstNonEmptyLine(value: string): string {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
