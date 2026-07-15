import { execFile } from "child_process";
import { createHash } from "node:crypto";
import * as fs from "fs";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

export const HERMES_INSTALL_RELEASE = "v2026.7.7.2";
export const HERMES_INSTALL_COMMIT = "9de9c25f620ff7f1ce0fd5457d596052d5159596";
export const HERMES_INSTALL_BASE_URL = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_INSTALL_COMMIT}/scripts`;
export const HERMES_UNIX_INSTALL_URL = `${HERMES_INSTALL_BASE_URL}/install.sh`;
export const HERMES_WINDOWS_INSTALL_URL = `${HERMES_INSTALL_BASE_URL}/install.ps1`;
export const HERMES_UNIX_INSTALL_SHA256 = "a93c65b01ea392e179cf872e182bd01a2b65c0c15f17833e9f9569033ef10e07";
export const HERMES_WINDOWS_INSTALL_SHA256 = "b4998d3b5fc9426f9fe2da1479424db0e840a5e67838a9f2bd14f7d52391cc81";
export const HERMES_INSTALL_MAX_DOWNLOAD_BYTES = 512 * 1024;
export const HERMES_INSTALL_DOWNLOAD_TIMEOUT_MS = 30_000;
export const HERMES_INSTALL_PROCESS_TIMEOUT_MS = 10 * 60_000;

export type HermesInstallStatus = "installed" | "cancelled" | "failed";
export type HermesInstallErrorKind =
  | "unsupported-platform"
  | "download"
  | "download-too-large"
  | "integrity"
  | "dependency"
  | "permission"
  | "timeout"
  | "cli-missing"
  | "failed";

export interface HermesInstallerRunnerOptions {
  shell: false;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type HermesInstallerRunner = (
  command: string,
  args: readonly string[],
  options: HermesInstallerRunnerOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface HermesInstallerFetchHeaders {
  get(name: string): string | null;
}

export interface HermesInstallerFetchResponse {
  ok: boolean;
  status: number;
  headers?: HermesInstallerFetchHeaders;
  body?: {
    getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> };
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  } | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type HermesInstallerFetch = (
  url: string,
  init: { method: "GET"; redirect: "error"; signal: AbortSignal }
) => Promise<HermesInstallerFetchResponse>;

export interface HermesInstallInvocation {
  command: "/bin/bash" | "powershell.exe";
  args: readonly string[];
  installDirectory: string;
  hermesHome: string;
  expectedCommands: readonly string[];
}

export interface HermesInstallOptions {
  home?: string;
  platform?: NodeJS.Platform | string;
  envPath?: string;
  tempRoot?: string;
  signal?: AbortSignal;
  downloadTimeoutMs?: number;
  processTimeoutMs?: number;
  maxDownloadBytes?: number;
  maxLogChars?: number;
  fetch?: HermesInstallerFetch;
  runner?: HermesInstallerRunner;
  exists?: (candidate: string) => boolean;
}

export interface HermesInstallResult {
  status: HermesInstallStatus;
  command: string | null;
  version: string | null;
  logs: string;
  errorKind?: HermesInstallErrorKind;
  error?: string;
}

export function hermesInstallSource(platform: string): { url: string; sha256: string; filename: string } {
  if (platform === "darwin" || platform === "linux") {
    return { url: HERMES_UNIX_INSTALL_URL, sha256: HERMES_UNIX_INSTALL_SHA256, filename: "install.sh" };
  }
  if (platform === "win32") {
    return { url: HERMES_WINDOWS_INSTALL_URL, sha256: HERMES_WINDOWS_INSTALL_SHA256, filename: "install.ps1" };
  }
  throw new HermesInstallerError("unsupported-platform", `Hermes 暂不支持 ${platform} 一键安装。`);
}

export function hermesInstallInvocation(platform: string, home: string, scriptPath: string): HermesInstallInvocation {
  if (platform === "darwin" || platform === "linux") {
    const hermesHome = path.join(home, ".hermes");
    const installDirectory = path.join(hermesHome, "hermes-agent");
    return {
      command: "/bin/bash",
      args: [
        scriptPath,
        "--commit", HERMES_INSTALL_COMMIT,
        "--dir", installDirectory,
        "--hermes-home", hermesHome,
        "--skip-setup",
        "--skip-browser",
        "--non-interactive"
      ],
      installDirectory,
      hermesHome,
      expectedCommands: [
        path.join(home, ".local", "bin", "hermes"),
        path.join(installDirectory, "venv", "bin", "hermes")
      ]
    };
  }
  if (platform === "win32") {
    const hermesHome = path.win32.join(home, ".hermes");
    const installDirectory = path.win32.join(hermesHome, "hermes-agent");
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-Commit", HERMES_INSTALL_COMMIT,
        "-HermesHome", hermesHome,
        "-InstallDir", installDirectory,
        "-SkipSetup",
        "-NonInteractive"
      ],
      installDirectory,
      hermesHome,
      expectedCommands: [path.win32.join(installDirectory, "venv", "Scripts", "hermes.exe")]
    };
  }
  throw new HermesInstallerError("unsupported-platform", `Hermes 暂不支持 ${platform} 一键安装。`);
}

export async function installHermesCli(options: HermesInstallOptions = {}): Promise<HermesInstallResult> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const maxLogChars = Math.max(256, options.maxLogChars ?? 8_000);
  let tempDirectory = "";

  try {
    throwIfAborted(options.signal);
    const source = hermesInstallSource(platform);
    const fetcher = options.fetch ?? defaultFetch;
    const script = await downloadPinnedInstaller(
      source,
      fetcher,
      options.signal,
      Math.max(1_000, options.downloadTimeoutMs ?? HERMES_INSTALL_DOWNLOAD_TIMEOUT_MS),
      Math.min(HERMES_INSTALL_MAX_DOWNLOAD_BYTES, Math.max(1_024, options.maxDownloadBytes ?? HERMES_INSTALL_MAX_DOWNLOAD_BYTES))
    );
    throwIfAborted(options.signal);

    tempDirectory = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "echoink-hermes-installer-"));
    await chmod(tempDirectory, 0o700);
    const scriptPath = path.join(tempDirectory, source.filename);
    await writeFile(scriptPath, script, { mode: 0o600, flag: "wx" });
    if (platform !== "win32") await chmod(scriptPath, 0o700);

    const invocation = hermesInstallInvocation(platform, home, scriptPath);
    const runner = options.runner ?? execFileRunner;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      HERMES_HOME: invocation.hermesHome,
      PATH: options.envPath ?? process.env.PATH ?? ""
    };
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
    const runnerOptions: HermesInstallerRunnerOptions = {
      shell: false,
      signal: options.signal,
      timeoutMs: Math.max(1_000, options.processTimeoutMs ?? HERMES_INSTALL_PROCESS_TIMEOUT_MS),
      maxBuffer: 2 * 1024 * 1024,
      env,
      cwd: tempDirectory
    };
    const install = await runner(invocation.command, invocation.args, runnerOptions);
    throwIfAborted(options.signal);

    const exists = options.exists ?? fs.existsSync;
    const command = invocation.expectedCommands.find((candidate) => exists(candidate)) ?? null;
    if (!command) {
      return {
        status: "failed",
        command: null,
        version: null,
        logs: limitedLogs(install, maxLogChars),
        errorKind: "cli-missing",
        error: "安装命令已结束，但没有找到 Hermes CLI。请查看安装日志后重试。"
      };
    }
    const versionResult = await runner(command, ["--version"], { ...runnerOptions, timeoutMs: 15_000 });
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
    const errorKind = hermesInstallErrorKind(error);
    return {
      status: "failed",
      command: null,
      version: null,
      logs: limitedText(error instanceof Error ? error.message : String(error), maxLogChars),
      errorKind,
      error: hermesInstallErrorMessage(errorKind, error)
    };
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function verifyHermesInstallerBytes(body: Uint8Array, expectedSha256: string, maxBytes: number): Buffer {
  const buffer = Buffer.from(body);
  if (buffer.byteLength > maxBytes) {
    throw new HermesInstallerError("download-too-large", "Hermes 安装器超过允许的下载大小。");
  }
  const actualHash = createHash("sha256").update(buffer).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actualHash !== expectedSha256) {
    throw new HermesInstallerError("integrity", "Hermes 安装器完整性校验失败，已拒绝执行。");
  }
  return buffer;
}

async function downloadPinnedInstaller(
  source: { url: string; sha256: string },
  fetcher: HermesInstallerFetch,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  maxBytes: number
): Promise<Buffer> {
  if (!source.url.startsWith("https://raw.githubusercontent.com/NousResearch/hermes-agent/")) {
    throw new HermesInstallerError("download", "Hermes 安装器来源不在允许列表中。");
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response: HermesInstallerFetchResponse;
    try {
      response = await fetcher(source.url, { method: "GET", redirect: "error", signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new HermesInstallerError("timeout", "下载安装器超时，请检查网络后重试。");
      if (externalSignal?.aborted) throw abortError();
      throw new HermesInstallerError("download", `下载安装器失败：${safeErrorText(error)}`);
    }
    if (!response.ok) throw new HermesInstallerError("download", `Hermes 官方服务器返回 HTTP ${response.status}。`);
    const declaredLength = Number(response.headers?.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new HermesInstallerError("download-too-large", "Hermes 安装器超过允许的下载大小。");
    }
    const body = await readBoundedBody(response, maxBytes, externalSignal);
    return verifyHermesInstallerBytes(body, source.sha256, maxBytes);
  } catch (error) {
    if (timedOut) throw new HermesInstallerError("timeout", "下载安装器超时，请检查网络后重试。");
    if (externalSignal?.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function readBoundedBody(response: HermesInstallerFetchResponse, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const append = (value: Uint8Array) => {
    total += value.byteLength;
    if (total > maxBytes) throw new HermesInstallerError("download-too-large", "Hermes 安装器超过允许的下载大小。");
    chunks.push(Buffer.from(value));
  };
  const reader = response.body?.getReader?.();
  if (reader) {
    while (true) {
      throwIfAborted(signal);
      const part = await reader.read();
      if (part.done) break;
      if (part.value) append(part.value);
    }
    return Buffer.concat(chunks, total);
  }
  const asyncIterator = response.body?.[Symbol.asyncIterator]?.();
  if (asyncIterator) {
    while (true) {
      throwIfAborted(signal);
      const part = await asyncIterator.next();
      if (part.done) break;
      append(part.value);
    }
    return Buffer.concat(chunks, total);
  }
  if (!response.arrayBuffer) throw new HermesInstallerError("download", "Hermes 安装器响应没有可读取的内容。");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new HermesInstallerError("download-too-large", "Hermes 安装器超过允许的下载大小。");
  return buffer;
}

function defaultFetch(url: string, init: { method: "GET"; redirect: "error"; signal: AbortSignal }): Promise<HermesInstallerFetchResponse> {
  return fetch(url, init) as unknown as Promise<HermesInstallerFetchResponse>;
}

function execFileRunner(command: string, args: readonly string[], options: HermesInstallerRunnerOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      shell: false,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: options.env,
      cwd: options.cwd
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

export class HermesInstallerError extends Error {
  constructor(readonly kind: HermesInstallErrorKind, message: string) {
    super(message);
    this.name = "HermesInstallerError";
  }
}

function hermesInstallErrorKind(error: unknown): HermesInstallErrorKind {
  if (error instanceof HermesInstallerError) return error.kind;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT") return "dependency";
  if (code === "EACCES" || code === "EPERM" || /EACCES|EPERM|permission denied/i.test(message)) return "permission";
  if ((error as { killed?: boolean } | null)?.killed || /timed?\s*out|timeout/i.test(message)) return "timeout";
  return "failed";
}

function hermesInstallErrorMessage(kind: HermesInstallErrorKind, error: unknown): string {
  if (error instanceof HermesInstallerError) return error.message;
  if (kind === "dependency") return "系统缺少运行 Hermes 官方安装器所需的 Bash 或 PowerShell。请安装依赖后重试。";
  if (kind === "permission") return "Hermes 安装器没有用户目录写入权限。EchoInk 不会使用 sudo，请检查目录权限后重试。";
  if (kind === "timeout") return "Hermes 安装等待超时，请检查网络后重试。";
  return `Hermes 安装失败：${limitedText(safeErrorText(error), 400)}`;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
}

function abortError(): Error {
  const error = new Error("安装已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|aborterror|安装已取消/i.test(error.message));
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
    .replace(/((?:api[_-]?key|authorization|token|device[_-]?code)\s*[:=]\s*)([^\s]+)/gi, "$1[已隐藏]");
}

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstNonEmptyLine(value: string): string {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
