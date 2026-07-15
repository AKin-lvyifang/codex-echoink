import { execFile } from "child_process";
import * as os from "os";
import * as path from "path";

export const CODEX_NPM_INSTALL_ARGS = ["install", "--global", "@openai/codex"] as const;

export type CodexInstallErrorKind = "npm-missing" | "permission" | "timeout" | "failed" | "cli-missing";
export type CodexInstallStatus = "installed" | "cancelled" | "failed";

export interface CodexInstallRunnerOptions {
  shell: false;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export type CodexInstallRunner = (
  command: string,
  args: readonly string[],
  options: CodexInstallRunnerOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface CodexInstallOptions {
  home?: string;
  platform?: NodeJS.Platform | string;
  envPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxLogChars?: number;
  exists?: (candidate: string) => boolean;
  runner?: CodexInstallRunner;
}

export interface CodexInstallResult {
  status: CodexInstallStatus;
  command: string | null;
  version: string | null;
  logs: string;
  errorKind?: CodexInstallErrorKind;
  error?: string;
}

export async function installCodexCli(options: CodexInstallOptions = {}): Promise<CodexInstallResult> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const runner = options.runner ?? execFileRunner;
  const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000);
  const maxLogChars = Math.max(256, options.maxLogChars ?? 8_000);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: options.envPath ?? process.env.PATH ?? "" };
  const runnerOptions: CodexInstallRunnerOptions = {
    shell: false,
    signal: options.signal,
    timeoutMs,
    maxBuffer: 1024 * 1024,
    env
  };

  try {
    const install = await runner(npmCommand, CODEX_NPM_INSTALL_ARGS, runnerOptions);
    const prefix = await runner(npmCommand, ["prefix", "--global"], runnerOptions);
    const command = installedCommandFromPrefix(prefix.stdout, platform, options.exists);
    if (!command) {
      return {
        status: "failed",
        command: null,
        version: null,
        logs: limitedLogs(install, maxLogChars),
        errorKind: "cli-missing",
        error: "安装命令已结束，但没有找到 Codex CLI。请打开终端重试。"
      };
    }
    const versionResult = await runner(command, ["--version"], { ...runnerOptions, timeoutMs: 10_000 });
    return {
      status: "installed",
      command,
      version: firstNonEmptyLine(versionResult.stdout || versionResult.stderr),
      logs: limitedLogs(install, maxLogChars)
    };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      return { status: "cancelled", command: null, version: null, logs: "", error: "安装已取消" };
    }
    const errorKind = installErrorKind(error);
    return {
      status: "failed",
      command: null,
      version: null,
      logs: limitedText(error instanceof Error ? error.message : String(error), maxLogChars),
      errorKind,
      error: installErrorMessage(errorKind, error)
    };
  }
}

function installedCommandFromPrefix(
  value: string,
  platform: string,
  exists: ((candidate: string) => boolean) | undefined
): string | null {
  const prefix = firstNonEmptyLine(value);
  if (!prefix) return null;
  const candidates = platform === "win32"
    ? [path.win32.join(prefix, "codex.cmd"), path.win32.join(prefix, "bin", "codex.cmd")]
    : [path.join(prefix, "bin", "codex")];
  if (!exists) return candidates[0] ?? null;
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

function execFileRunner(command: string, args: readonly string[], options: CodexInstallRunnerOptions): Promise<{ stdout: string; stderr: string }> {
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

function installErrorKind(error: unknown): CodexInstallErrorKind {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT") return "npm-missing";
  if (code === "EACCES" || code === "EPERM" || /EACCES|permission denied/i.test(message)) return "permission";
  if ((error as { killed?: boolean } | null)?.killed || /timed?\s*out|timeout/i.test(message)) return "timeout";
  return "failed";
}

function installErrorMessage(kind: CodexInstallErrorKind, error: unknown): string {
  if (kind === "npm-missing") return "没有找到 npm。请先安装 Node.js，再打开终端运行官方安装命令。";
  if (kind === "permission") return "npm 没有全局安装权限。EchoInk 不会使用 sudo；请打开终端按 npm 官方方式修复权限。";
  if (kind === "timeout") return "安装等待超时，请检查网络后重试。";
  const message = error instanceof Error ? error.message : String(error);
  return `Codex 安装失败：${limitedText(message, 400)}`;
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
  const normalized = String(value ?? "").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}\n…`;
}

function firstNonEmptyLine(value: string): string {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
