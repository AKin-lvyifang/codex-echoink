import { execFile } from "child_process";
import { createHash } from "node:crypto";
import * as fs from "fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  emitAgentSetupProgress,
  type AgentSetupProgressHandler
} from "./agent-setup";

export const HERMES_INSTALL_RELEASE = "v2026.7.7.2";
export const HERMES_INSTALL_COMMIT = "9de9c25f620ff7f1ce0fd5457d596052d5159596";
export const HERMES_INSTALL_BASE_URL = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_INSTALL_COMMIT}/scripts`;
export const HERMES_UNIX_INSTALL_URL = `${HERMES_INSTALL_BASE_URL}/install.sh`;
export const HERMES_WINDOWS_INSTALL_URL = `${HERMES_INSTALL_BASE_URL}/install.ps1`;
export const HERMES_UNIX_INSTALL_SHA256 = "a93c65b01ea392e179cf872e182bd01a2b65c0c15f17833e9f9569033ef10e07";
export const HERMES_WINDOWS_INSTALL_SHA256 = "b4998d3b5fc9426f9fe2da1479424db0e840a5e67838a9f2bd14f7d52391cc81";
export const HERMES_INSTALL_MAX_DOWNLOAD_BYTES = 512 * 1024;
export const HERMES_REPOSITORY_URL = "https://github.com/NousResearch/hermes-agent.git";
export const HERMES_UV_VERSION = "0.11.27";
export const HERMES_UV_RELEASE_BASE_URL = `https://github.com/astral-sh/uv/releases/download/${HERMES_UV_VERSION}`;
export const HERMES_UV_MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const HERMES_INSTALL_DOWNLOAD_TIMEOUT_MS = 30_000;
export const HERMES_INSTALL_PROCESS_TIMEOUT_MS = 10 * 60_000;
export const HERMES_UNIX_SAFE_STAGES = ["path", "config", "complete"] as const;
export const HERMES_WINDOWS_SAFE_STAGES = ["path", "config-templates", "bootstrap-marker"] as const;
export const HERMES_GIT_NO_REPLACE_ARGS = ["--no-replace-objects"] as const;

export type HermesUvLibc = "gnu" | "musl";
export type HermesUvArchiveFormat = "tar.gz" | "zip";

export interface HermesUvAsset {
  url: string;
  sha256: string;
  filename: string;
  expectedBytes: number;
  archiveFormat: HermesUvArchiveFormat;
  executableRelativePath: string;
}

const HERMES_UV_ASSETS: Readonly<Record<string, HermesUvAsset>> = {
  "darwin-arm64": uvAsset("uv-aarch64-apple-darwin.tar.gz", "34e63cc0de0aebbc8d424767c588c31b685479f045f9ced9e5ef43ff9e0e8d63", 22_258_995, "tar.gz", "uv-aarch64-apple-darwin/uv"),
  "darwin-x64": uvAsset("uv-x86_64-apple-darwin.tar.gz", "9f00047455b2a9e81f282297fca39cdd6cd5761a6b0ce75e2d7698744c59e1af", 23_818_581, "tar.gz", "uv-x86_64-apple-darwin/uv"),
  "linux-arm64-gnu": uvAsset("uv-aarch64-unknown-linux-gnu.tar.gz", "321580b9a7069d0cdbd8db9482a5fb62b4f1285110f847746e3b495408e3a08c", 24_321_884, "tar.gz", "uv-aarch64-unknown-linux-gnu/uv"),
  "linux-x64-gnu": uvAsset("uv-x86_64-unknown-linux-gnu.tar.gz", "0f4088a04ac92e4c52b4b76759d227a1047355e0ce1dd57cd738a6dec5966bd9", 25_942_873, "tar.gz", "uv-x86_64-unknown-linux-gnu/uv"),
  "linux-arm64-musl": uvAsset("uv-aarch64-unknown-linux-musl.tar.gz", "b0b1909a7e5caf2ec0cbe2649f5171050c26d85efb65d9d4de2cfe754dc14ea3", 24_183_474, "tar.gz", "uv-aarch64-unknown-linux-musl/uv"),
  "linux-x64-musl": uvAsset("uv-x86_64-unknown-linux-musl.tar.gz", "5d5594af1530c7c31e46a8cc0a35ceb4d28f3890049efe2149ac53c9ad121493", 26_179_554, "tar.gz", "uv-x86_64-unknown-linux-musl/uv"),
  "win32-arm64": uvAsset("uv-aarch64-pc-windows-msvc.zip", "7566a80fe96ee84e6938621a1b704f44b0db546672bf43025905784b2507b7fe", 23_622_736, "zip", "uv.exe"),
  "win32-x64": uvAsset("uv-x86_64-pc-windows-msvc.zip", "b7e32288ce0e289dbe94d2cac7adbb008f74f0e038542a2d9969dd50eb7056ee", 25_266_267, "zip", "uv.exe")
};

function uvAsset(
  filename: string,
  sha256: string,
  expectedBytes: number,
  archiveFormat: HermesUvArchiveFormat,
  executableRelativePath: string
): HermesUvAsset {
  return {
    url: `${HERMES_UV_RELEASE_BASE_URL}/${filename}`,
    sha256,
    filename,
    expectedBytes,
    archiveFormat,
    executableRelativePath
  };
}

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
  | "rollback-failed"
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
    getReader?: () => {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel?(reason?: unknown): Promise<void>;
      releaseLock?(): void;
    };
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  } | null;
}

export type HermesInstallerFetch = (
  url: string,
  init: { method: "GET"; redirect: "error" | "follow"; signal: AbortSignal }
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
  arch?: NodeJS.Architecture | string;
  libc?: HermesUvLibc;
  uid?: number;
  envPath?: string;
  tempRoot?: string;
  signal?: AbortSignal;
  downloadTimeoutMs?: number;
  processTimeoutMs?: number;
  maxDownloadBytes?: number;
  maxUvDownloadBytes?: number;
  maxLogChars?: number;
  fetch?: HermesInstallerFetch;
  runner?: HermesInstallerRunner;
  exists?: (candidate: string) => boolean;
  onProgress?: AgentSetupProgressHandler;
}

export interface HermesInstallResult {
  status: HermesInstallStatus;
  command: string | null;
  version: string | null;
  logs: string;
  errorKind?: HermesInstallErrorKind;
  error?: string;
}

export interface HermesStagedInstallTransaction<T> {
  installDirectory: string;
  stagingDirectory: string;
  previousDirectory: string | null;
  value: T;
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

export function hermesUvAsset(platform: string, arch: string, libc?: HermesUvLibc): HermesUvAsset {
  const normalizedArch = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  const key = platform === "linux"
    ? `${platform}-${normalizedArch}-${libc ?? detectLinuxLibc()}`
    : `${platform}-${normalizedArch}`;
  const asset = HERMES_UV_ASSETS[key];
  if (!asset) {
    throw new HermesInstallerError("unsupported-platform", `Hermes 暂不支持 ${platform}/${arch}${platform === "linux" ? `/${libc ?? "auto"}` : ""} 一键安装。`);
  }
  return { ...asset };
}

export function hermesInstallInvocation(platform: string, home: string, scriptPath: string, stage = "path"): HermesInstallInvocation {
  if (platform === "darwin" || platform === "linux") {
    if (!(HERMES_UNIX_SAFE_STAGES as readonly string[]).includes(stage)) {
      throw new HermesInstallerError("failed", `拒绝执行不安全的 Hermes Unix 安装阶段：${stage}`);
    }
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
        "--non-interactive",
        "--stage", stage,
        "--json"
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
    if (!(HERMES_WINDOWS_SAFE_STAGES as readonly string[]).includes(stage)) {
      throw new HermesInstallerError("failed", `拒绝执行不安全的 Hermes Windows 安装阶段：${stage}`);
    }
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
        "-NonInteractive",
        "-Stage", stage,
        "-Json"
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
  const arch = options.arch ?? process.arch;
  const home = options.home ?? os.homedir();
  const maxLogChars = Math.max(256, options.maxLogChars ?? 8_000);
  let tempDirectory = "";
  const logParts: string[] = [];

  try {
    throwIfAborted(options.signal);
    emitAgentSetupProgress(options.onProgress, "checking-environment");
    if ((platform === "darwin" || platform === "linux") && (options.uid ?? process.getuid?.()) === 0) {
      throw new HermesInstallerError("permission", "EchoInk 拒绝以 root 身份安装 Hermes。请使用普通用户重试；安装过程不会执行 sudo。");
    }
    const source = hermesInstallSource(platform);
    const uvSource = hermesUvAsset(platform, arch, platform === "linux" ? options.libc ?? detectLinuxLibc() : undefined);
    const firstSafeStage = platform === "win32" ? HERMES_WINDOWS_SAFE_STAGES[0] : HERMES_UNIX_SAFE_STAGES[0];
    const platformPath = platform === "win32" ? path.win32 : path;
    assertSafeHermesInstallPaths(home, platform);

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

    const invocation = hermesInstallInvocation(platform, home, scriptPath, firstSafeStage);
    const runner = options.runner ?? execFileRunner;
    const baseEnv = controlledInstallerEnvironment(home, invocation.hermesHome, options.envPath);
    const baseRunnerOptions: HermesInstallerRunnerOptions = {
      shell: false,
      signal: options.signal,
      timeoutMs: Math.max(1_000, options.processTimeoutMs ?? HERMES_INSTALL_PROCESS_TIMEOUT_MS),
      maxBuffer: 4 * 1024 * 1024,
      env: baseEnv,
      cwd: tempDirectory
    };

    const run = async (
      command: string,
      args: readonly string[],
      overrides: Partial<Pick<HermesInstallerRunnerOptions, "cwd" | "env" | "timeoutMs">> = {}
    ): Promise<{ stdout: string; stderr: string }> => {
      throwIfAborted(options.signal);
      const result = await runner(command, args, { ...baseRunnerOptions, ...overrides });
      logParts.push([result.stdout, result.stderr].filter(Boolean).join("\n"));
      return result;
    };

    const gitControl = await controlledGitEnvironment(baseEnv, tempDirectory, platform);
    const gitCommand = resolveRequiredExecutable("git", platform, baseEnv.PATH ?? "");
    try {
      await run(gitCommand, [...HERMES_GIT_NO_REPLACE_ARGS, "--version"], {
        env: gitControl.env,
        timeoutMs: 15_000
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      throw new HermesInstallerError("dependency", "系统未找到可用的 Git。EchoInk 不会自动安装系统依赖，请先安装 Git 后重试。");
    }
    emitAgentSetupProgress(options.onProgress, "installing-cli");
    const uvArchive = await downloadPinnedUv(
      uvSource,
      fetcher,
      options.signal,
      Math.max(1_000, options.downloadTimeoutMs ?? HERMES_INSTALL_DOWNLOAD_TIMEOUT_MS),
      Math.min(HERMES_UV_MAX_DOWNLOAD_BYTES, Math.max(1_024, options.maxUvDownloadBytes ?? HERMES_UV_MAX_DOWNLOAD_BYTES))
    );
    const uvArchivePath = path.join(tempDirectory, uvSource.filename);
    await writeFile(uvArchivePath, uvArchive, { mode: 0o600, flag: "wx" });
    const uvExtractDirectory = path.join(tempDirectory, "uv");
    await mkdir(uvExtractDirectory, { recursive: false, mode: 0o700 });
    const archiveCommand = resolveArchiveCommand(platform, baseEnv);
    const archiveArgs = uvSource.archiveFormat === "tar.gz"
      ? ["-xzf", uvArchivePath, "-C", uvExtractDirectory]
      : ["-xf", uvArchivePath, "-C", uvExtractDirectory];
    await run(archiveCommand, archiveArgs);
    const uvExecutable = path.join(uvExtractDirectory, ...uvSource.executableRelativePath.split("/"));
    const exists = options.exists ?? fs.existsSync;
    if (!exists(uvExecutable)) {
      throw new HermesInstallerError("integrity", "固定 uv 资产解压后缺少预期可执行文件，已拒绝继续安装。");
    }
    if (platform !== "win32") await chmod(uvExecutable, 0o700);
    const uvVersion = await run(uvExecutable, ["--version"], { timeoutMs: 15_000 });
    if (!new RegExp(`^uv\\s+${escapeRegExp(HERMES_UV_VERSION)}(?:\\s|$)`, "m").test(uvVersion.stdout || uvVersion.stderr)) {
      throw new HermesInstallerError("integrity", `固定 uv 资产版本不匹配，预期 ${HERMES_UV_VERSION}。`);
    }

    assertSafeHermesInstallPaths(home, platform);
    const managedUv = await preserveOrInstallManagedUv(uvExecutable, invocation.hermesHome, platform, logParts);
    const stageEnvironment = platform === "win32"
      ? baseEnv
      : { ...baseEnv, PATH: await createRestrictedUnixStagePath(tempDirectory) };
    const safeStages = platform === "win32" ? HERMES_WINDOWS_SAFE_STAGES : HERMES_UNIX_SAFE_STAGES;
    const transaction = await runHermesStagedInstallTransaction({
      installDirectory: invocation.installDirectory,
      platform,
      logs: logParts,
      build: async (stagingDirectory) => {
        throwIfAborted(options.signal);
        assertSafeHermesInstallPaths(home, platform);
        await preparePinnedHermesRepository(stagingDirectory, platform, gitCommand, run, gitControl);
        const stagingVenv = platformPath.join(stagingDirectory, "venv");
        const stagingPython = platform === "win32"
          ? platformPath.join(stagingVenv, "Scripts", "python.exe")
          : platformPath.join(stagingVenv, "bin", "python");
        const lockfile = platformPath.join(stagingDirectory, "uv.lock");
        if (!exists(lockfile)) {
          throw new HermesInstallerError("integrity", "固定 Hermes 提交中缺少 uv.lock，已拒绝降级到未锁定依赖安装。");
        }
        const uvEnvironment = controlledUvEnvironment(baseEnv, invocation.hermesHome, stagingVenv, platform);
        await run(managedUv, ["venv", stagingVenv, "--python", "3.11", "--relocatable"], {
          cwd: stagingDirectory,
          env: uvEnvironment
        });
        await run(managedUv, ["sync", "--extra", "all", "--locked", "--no-editable"], {
          cwd: stagingDirectory,
          env: { ...uvEnvironment, UV_PYTHON: stagingPython }
        });
        const stagingCommand = platform === "win32"
          ? platformPath.join(stagingVenv, "Scripts", "hermes.exe")
          : platformPath.join(stagingVenv, "bin", "hermes");
        if (!exists(stagingCommand)) {
          throw new HermesInstallerError("cli-missing", "固定 Hermes 环境同步完成，但 staging 中没有找到 CLI，已保留旧安装。");
        }
        await run(stagingCommand, ["--version"], { cwd: stagingDirectory, timeoutMs: 15_000 });
      },
      afterActivate: async () => {
        emitAgentSetupProgress(options.onProgress, "verifying-version");
        assertSafeHermesInstallPaths(home, platform);
        for (const stage of safeStages) {
          throwIfAborted(options.signal);
          const stageInvocation = hermesInstallInvocation(platform, home, scriptPath, stage);
          const stageCommand = platform === "win32" ? resolveWindowsPowerShell(baseEnv) : stageInvocation.command;
          const stageResult = await run(stageCommand, stageInvocation.args, {
            cwd: tempDirectory,
            env: stageEnvironment
          });
          verifyHermesStageResult(stageResult.stdout, stage);
        }
        throwIfAborted(options.signal);
        const command = invocation.expectedCommands.find((candidate) => exists(candidate)) ?? null;
        if (!command) {
          throw new HermesInstallerError("cli-missing", "安装命令已结束，但没有找到 Hermes CLI。请查看安装日志后重试。");
        }
        const versionResult = await run(command, ["--version"], {
          cwd: invocation.installDirectory,
          timeoutMs: 15_000
        });
        return {
          command,
          version: firstNonEmptyLine(versionResult.stdout || versionResult.stderr)
        };
      }
    });
    return {
      status: "installed",
      command: transaction.value.command,
      version: transaction.value.version,
      logs: limitedText(logParts.filter(Boolean).join("\n"), maxLogChars)
    };
  } catch (error) {
    if (!(error instanceof HermesInstallerError && error.kind === "rollback-failed")
      && (isAbortError(error) || options.signal?.aborted)) {
      return { status: "cancelled", command: null, version: null, logs: "", error: "安装已取消" };
    }
    const errorKind = hermesInstallErrorKind(error);
    return {
      status: "failed",
      command: null,
      version: null,
      logs: limitedText([...logParts, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n"), maxLogChars),
      errorKind,
      error: hermesInstallErrorMessage(errorKind, error)
    };
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface RunHermesStagedInstallOptions<T> {
  installDirectory: string;
  platform: string;
  logs?: string[];
  renamePath?: (from: string, to: string) => Promise<void>;
  build(stagingDirectory: string): Promise<void>;
  afterActivate(): Promise<T>;
}

interface HermesInstallActivation {
  installDirectory: string;
  stagingDirectory: string;
  previousDirectory: string | null;
}

/**
 * Builds a complete Hermes tree beside the live install and only then swaps it
 * into place. A failed post-activation stage restores the old tree without
 * deleting either version.
 */
export async function runHermesStagedInstallTransaction<T>(
  options: RunHermesStagedInstallOptions<T>
): Promise<HermesStagedInstallTransaction<T>> {
  const platformPath = options.platform === "win32" ? path.win32 : path;
  const parentDirectory = platformPath.dirname(options.installDirectory);
  await assertPlainDirectory(parentDirectory, "Hermes 安装父目录");
  const stagingDirectory = await mkdtemp(`${options.installDirectory}.echoink-staging-`);
  await chmod(stagingDirectory, 0o700).catch(() => undefined);
  const renamePath = options.renamePath ?? rename;
  let activation: HermesInstallActivation | null = null;
  try {
    await options.build(stagingDirectory);
    activation = await activateHermesStagingInstall(options.installDirectory, stagingDirectory, options.platform, renamePath);
    const value = await options.afterActivate();
    if (activation.previousDirectory) {
      options.logs?.push(`旧版 Hermes 已完整保留在 ${activation.previousDirectory}。`);
    }
    return {
      installDirectory: options.installDirectory,
      stagingDirectory,
      previousDirectory: activation.previousDirectory,
      value
    };
  } catch (error) {
    if (!activation) {
      if (!(error instanceof HermesInstallerError && error.kind === "rollback-failed")) {
        options.logs?.push(`Hermes staging 已保留在 ${stagingDirectory}，正式安装未被修改。`);
      }
      throw error;
    }
    if (!activation.previousDirectory) {
      options.logs?.push("Hermes 首次安装已完成原子切换；后续阶段失败，已保留完整安装供重试。");
      throw error;
    }
    try {
      const failedDirectory = await rollbackHermesStagingInstall(activation, options.platform, renamePath);
      options.logs?.push(`Hermes 旧版已恢复；失败的新版本保留在 ${failedDirectory}。`);
    } catch (rollbackError) {
      if (rollbackError instanceof HermesInstallerError && rollbackError.kind === "rollback-failed") {
        throw rollbackError;
      }
      throw new HermesInstallerError(
        "rollback-failed",
        `Hermes 安装失败，且旧版自动恢复失败。旧版仍保留在 ${activation.previousDirectory}，请停止重试并检查目录：${safeErrorText(rollbackError)}`
      );
    }
    throw error;
  }
}

/** Rejects symlink/junction ancestors and existing paths escaping the real home. */
export function assertSafeHermesInstallPaths(home: string, platform: string): void {
  const platformPath = platform === "win32" ? path.win32 : path;
  if (!platformPath.isAbsolute(home)) {
    throw new HermesInstallerError("failed", "Hermes 用户目录必须是绝对路径，已拒绝继续安装。");
  }
  const resolvedHome = platformPath.resolve(home);
  let homeStat: fs.Stats;
  let realHome: string;
  try {
    homeStat = fs.lstatSync(resolvedHome);
    realHome = fs.realpathSync(resolvedHome);
  } catch {
    throw new HermesInstallerError("failed", "无法安全读取 Hermes 用户目录，已拒绝继续安装。");
  }
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new HermesInstallerError("failed", "Hermes 用户目录不能是符号链接或非目录，已拒绝继续安装。");
  }
  const invocation = hermesInstallInvocation(platform, resolvedHome, "installer", platform === "win32" ? "path" : "path");
  const venvDirectory = platformPath.join(invocation.installDirectory, "venv");
  const criticalDirectories = [
    invocation.hermesHome,
    platformPath.join(invocation.hermesHome, "bin"),
    platformPath.join(invocation.hermesHome, "python"),
    platformPath.join(invocation.hermesHome, "cache"),
    platformPath.join(invocation.hermesHome, "cache", "uv"),
    invocation.installDirectory,
    venvDirectory,
    platformPath.join(venvDirectory, platform === "win32" ? "Scripts" : "bin")
  ];
  if (platform !== "win32") {
    criticalDirectories.push(platformPath.join(resolvedHome, ".local"));
    criticalDirectories.push(platformPath.join(resolvedHome, ".local", "bin"));
  }
  for (const target of criticalDirectories) {
    assertContainedDirectoryAncestors(resolvedHome, realHome, target, platform);
  }
}

async function activateHermesStagingInstall(
  installDirectory: string,
  stagingDirectory: string,
  platform: string,
  renamePath: (from: string, to: string) => Promise<void>
): Promise<HermesInstallActivation> {
  const platformPath = platform === "win32" ? path.win32 : path;
  if (normalizePathForComparison(platformPath.dirname(stagingDirectory), platform)
    !== normalizePathForComparison(platformPath.dirname(installDirectory), platform)) {
    throw new HermesInstallerError("failed", "Hermes staging 与正式目录不在同一父目录，无法安全原子切换。");
  }
  await assertPlainDirectory(stagingDirectory, "Hermes staging");
  const hasExistingInstall = fs.existsSync(installDirectory);
  if (hasExistingInstall) await assertPlainDirectory(installDirectory, "Hermes 正式安装目录");
  const previousDirectory = hasExistingInstall
    ? uniqueSiblingPath(`${installDirectory}.previous-`)
    : null;
  if (previousDirectory) await renamePath(installDirectory, previousDirectory);
  try {
    await renamePath(stagingDirectory, installDirectory);
  } catch (activationError) {
    if (previousDirectory) {
      try {
        await renamePath(previousDirectory, installDirectory);
      } catch (restoreError) {
        throw new HermesInstallerError(
          "rollback-failed",
          `Hermes 新版激活失败，且旧版无法恢复。正式目录：${installDirectory}；旧版：${previousDirectory}；staging：${stagingDirectory}。请停止重试并检查目录。激活错误：${safeErrorText(activationError)}；恢复错误：${safeErrorText(restoreError)}`
        );
      }
    }
    throw activationError;
  }
  return { installDirectory, stagingDirectory, previousDirectory };
}

async function rollbackHermesStagingInstall(
  activation: HermesInstallActivation,
  platform: string,
  renamePath: (from: string, to: string) => Promise<void>
): Promise<string> {
  if (!activation.previousDirectory) return activation.installDirectory;
  const failedDirectory = uniqueSiblingPath(`${activation.installDirectory}.failed-`);
  const currentExists = fs.existsSync(activation.installDirectory);
  if (currentExists) await renamePath(activation.installDirectory, failedDirectory);
  try {
    await renamePath(activation.previousDirectory, activation.installDirectory);
  } catch (restorePreviousError) {
    if (currentExists) {
      try {
        await renamePath(failedDirectory, activation.installDirectory);
      } catch (restoreCurrentError) {
        throw new HermesInstallerError(
          "rollback-failed",
          `Hermes 旧版恢复失败，且失败的新版本也无法放回正式目录。正式目录：${activation.installDirectory}；旧版：${activation.previousDirectory}；失败新版：${failedDirectory}。请停止重试并检查目录。旧版恢复错误：${safeErrorText(restorePreviousError)}；新版恢复错误：${safeErrorText(restoreCurrentError)}`
        );
      }
    }
    throw restorePreviousError;
  }
  const platformPath = platform === "win32" ? path.win32 : path;
  if (normalizePathForComparison(platformPath.dirname(failedDirectory), platform)
    !== normalizePathForComparison(platformPath.dirname(activation.installDirectory), platform)) {
    throw new HermesInstallerError("failed", "Hermes 回滚目录不在正式目录同一父目录。");
  }
  return failedDirectory;
}

function uniqueSiblingPath(prefix: string): string {
  const seed = `${Date.now()}-${process.pid}`;
  let candidate = `${prefix}${seed}`;
  let suffix = 0;
  while (fs.existsSync(candidate)) candidate = `${prefix}${seed}-${++suffix}`;
  return candidate;
}

async function assertPlainDirectory(candidate: string, label: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    throw new HermesInstallerError("failed", `${label}不存在或无法安全读取，已拒绝继续安装。`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HermesInstallerError("failed", `${label}不是普通目录，已拒绝继续安装。`);
  }
}

function assertContainedDirectoryAncestors(home: string, realHome: string, target: string, platform: string): void {
  const platformPath = platform === "win32" ? path.win32 : path;
  const relative = platformPath.relative(home, platformPath.resolve(target));
  if (!relative || relative === ".") return;
  if (relative === ".." || relative.startsWith(`..${platformPath.sep}`) || platformPath.isAbsolute(relative)) {
    throw new HermesInstallerError("failed", "Hermes 安装路径越出当前用户目录，已拒绝继续安装。");
  }
  let current = home;
  for (const part of relative.split(platformPath.sep).filter(Boolean)) {
    current = platformPath.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") break;
      throw new HermesInstallerError("failed", `无法安全检查 Hermes 路径：${current}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HermesInstallerError("failed", `Hermes 关键路径不能包含符号链接、junction 或非目录：${current}`);
    }
    let realCurrent: string;
    try {
      realCurrent = fs.realpathSync(current);
    } catch {
      throw new HermesInstallerError("failed", `无法解析 Hermes 关键路径：${current}`);
    }
    if (!isPathInside(realHome, realCurrent, platform)) {
      throw new HermesInstallerError("failed", `Hermes 关键路径解析后越出当前用户目录：${current}`);
    }
  }
}

function isPathInside(parent: string, candidate: string, platform: string): boolean {
  const platformPath = platform === "win32" ? path.win32 : path;
  const relative = platformPath.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${platformPath.sep}`) && !platformPath.isAbsolute(relative));
}

type HermesControlledRun = (
  command: string,
  args: readonly string[],
  overrides?: Partial<Pick<HermesInstallerRunnerOptions, "cwd" | "env" | "timeoutMs">>
) => Promise<{ stdout: string; stderr: string }>;

interface HermesGitControl {
  env: NodeJS.ProcessEnv;
  hooksDirectory: string;
}

function controlledInstallerEnvironment(home: string, hermesHome: string, envPath?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HERMES_HOME: hermesHome,
    PATH: envPath ?? process.env.PATH ?? "",
    NO_COLOR: "1"
  };
  for (const key of Object.keys(env)) {
    if (/^(?:UV_|PIP_|BASH_FUNC_)/i.test(key)) delete env[key];
  }
  for (const key of [
    "BASH_ENV",
    "BASHOPTS",
    "SHELLOPTS",
    "ENV",
    "CDPATH",
    "GLOBIGNORE",
    "PROMPT_COMMAND",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "VIRTUAL_ENV",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "CARGO_TARGET_DIR",
    "CC",
    "CXX",
    "AR",
    "LD",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "TAR_OPTIONS",
    "GZIP",
    "BZIP2",
    "XZ_OPT"
  ]) {
    delete env[key];
  }
  return env;
}

function controlledUvEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  hermesHome: string,
  venvDirectory: string,
  platform: string
): NodeJS.ProcessEnv {
  const platformPath = platform === "win32" ? path.win32 : path;
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (/^(?:UV_|PIP_)/i.test(key)) delete env[key];
  }
  env.UV_NO_CONFIG = "1";
  env.UV_PROJECT_ENVIRONMENT = venvDirectory;
  env.UV_PYTHON_INSTALL_DIR = platformPath.join(hermesHome, "python");
  env.UV_CACHE_DIR = platformPath.join(hermesHome, "cache", "uv");
  env.UV_LINK_MODE = "copy";
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONSAFEPATH = "1";
  return env;
}

async function controlledGitEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  tempDirectory: string,
  platform: string
): Promise<HermesGitControl> {
  const configPath = path.join(tempDirectory, "empty-gitconfig");
  const hooksDirectory = path.join(tempDirectory, "empty-git-hooks");
  await writeFile(configPath, "", { mode: 0o600, flag: "wx" });
  await mkdir(hooksDirectory, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|GCM_)/i.test(key)) delete env[key];
  }
  delete env.SSH_ASKPASS;
  return {
    hooksDirectory,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: configPath,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: platform === "win32" ? "" : "/usr/bin/false"
    }
  };
}

async function preparePinnedHermesRepository(
  installDirectory: string,
  platform: string,
  gitCommand: string,
  run: HermesControlledRun,
  control: HermesGitControl
): Promise<void> {
  const platformPath = platform === "win32" ? path.win32 : path;
  const gitDirectory = platformPath.join(installDirectory, ".git");
  const existed = fs.existsSync(installDirectory);
  if (!existed) {
    await mkdir(platformPath.dirname(installDirectory), { recursive: true, mode: 0o700 });
    await mkdir(installDirectory, { mode: 0o700 });
  } else {
    await assertPlainDirectory(installDirectory, "Hermes staging");
    if (fs.existsSync(gitDirectory) || fs.readdirSync(installDirectory).length > 0) {
      throw new HermesInstallerError("failed", "Hermes staging 在构建前不是空目录，已拒绝覆盖。");
    }
  }

  const gitPrefix = controlledGitPrefix(control);
  const runGit = (args: readonly string[]) => run(gitCommand, [...gitPrefix, ...args], { env: control.env });

  await runGit(["init", "--quiet", installDirectory]);
  await runGit([
    "-C", installDirectory,
    "fetch",
    "--depth", "1",
    "--no-tags",
    HERMES_REPOSITORY_URL,
    `refs/tags/${HERMES_INSTALL_RELEASE}`
  ]);
  await runGit([
    "-C", installDirectory,
    "checkout",
    "--detach",
    "--no-recurse-submodules",
    HERMES_INSTALL_COMMIT
  ]);
  const verified = await runGit(["-C", installDirectory, "rev-parse", "HEAD"]);
  if (firstNonEmptyLine(verified.stdout) !== HERMES_INSTALL_COMMIT) {
    throw new HermesInstallerError("integrity", "Hermes 仓库没有落在固定提交，已拒绝继续安装。");
  }
}

function controlledGitPrefix(control: HermesGitControl): readonly string[] {
  return [
    ...HERMES_GIT_NO_REPLACE_ARGS,
    "-c", `core.hooksPath=${control.hooksDirectory}`,
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-c", "protocol.file.allow=never"
  ];
}

async function preserveOrInstallManagedUv(
  verifiedUvExecutable: string,
  hermesHome: string,
  platform: string,
  logs: string[]
): Promise<string> {
  const platformPath = platform === "win32" ? path.win32 : path;
  const binDirectory = platformPath.join(hermesHome, "bin");
  const managedUv = platformPath.join(binDirectory, platform === "win32" ? "uv.exe" : "uv");
  if (fs.existsSync(managedUv)) {
    logs.push(`已保留现有 Hermes uv；本次安装使用已校验的 uv ${HERMES_UV_VERSION} 临时副本。`);
    return verifiedUvExecutable;
  }
  if (fs.existsSync(binDirectory)) {
    const stat = fs.lstatSync(binDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      logs.push("Hermes bin 路径不是普通目录，已保留现场并使用临时 uv。 ");
      return verifiedUvExecutable;
    }
  } else {
    await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  }
  try {
    await copyFile(verifiedUvExecutable, managedUv, fs.constants.COPYFILE_EXCL);
    if (platform !== "win32") await chmod(managedUv, 0o700);
    logs.push(`已保存固定 uv ${HERMES_UV_VERSION}；本次构建继续使用临时目录中的已校验副本。`);
    return verifiedUvExecutable;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      logs.push("检测到并发创建的 Hermes uv，已保留该文件并继续使用临时 uv。");
      return verifiedUvExecutable;
    }
    throw error;
  }
}

async function createRestrictedUnixStagePath(tempDirectory: string): Promise<string> {
  const safeBin = path.join(tempDirectory, "safe-bin");
  await mkdir(safeBin, { mode: 0o700 });
  const allowedCommands = [
    "awk", "basename", "bash", "cat", "chmod", "cp", "dirname", "env", "grep", "head", "id",
    "ls", "mkdir", "mktemp", "mv", "rm", "sed", "sh", "tail", "touch", "tr", "uname", "which"
  ];
  for (const command of allowedCommands) {
    const target = resolveTrustedUnixExecutable(command);
    if (!target) continue;
    await symlink(target, path.join(safeBin, command)).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
  }
  return safeBin;
}

function resolveTrustedUnixExecutable(command: string): string | null {
  for (const directory of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through fixed system locations.
    }
  }
  return null;
}

function resolveRequiredExecutable(command: string, platform: string, envPath: string): string {
  const executable = resolveExecutableOnPath(command, envPath, platform);
  if (!executable) {
    const displayName = command === "git" ? "Git" : command;
    throw new HermesInstallerError("dependency", `系统缺少 ${displayName}。EchoInk 不会自动安装系统依赖，请安装后重试。`);
  }
  return executable;
}

function resolveArchiveCommand(platform: string, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    const candidate = path.win32.join(systemRoot, "System32", "tar.exe");
    if (fs.existsSync(candidate)) return candidate;
    throw new HermesInstallerError("dependency", "系统缺少 Windows tar 归档工具。EchoInk 不会下载或执行第三方解压器，请更新系统后重试。");
  }
  const candidate = resolveTrustedUnixExecutable("tar");
  if (candidate) return candidate;
  throw new HermesInstallerError("dependency", "系统缺少 tar 归档工具。EchoInk 不会自动安装系统依赖，请安装后重试。");
}

function resolveWindowsPowerShell(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const candidate = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(candidate)) return candidate;
  throw new HermesInstallerError("dependency", "系统缺少 Windows PowerShell。EchoInk 不会调用未知路径的 PowerShell，请修复系统组件后重试。");
}

function resolveExecutableOnPath(command: string, envPath: string, platform: string = process.platform): string | null {
  const platformPath = platform === "win32" ? path.win32 : path;
  const delimiter = platform === "win32" ? path.win32.delimiter : path.delimiter;
  const names = platform === "win32" ? [`${command}.exe`] : [command];
  const directories = envPath.split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = platformPath.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue looking through PATH.
      }
    }
  }
  return null;
}

function verifyHermesStageResult(stdout: string, expectedStage: string): void {
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line) as { ok?: unknown; stage?: unknown; skipped?: unknown; reason?: unknown };
      if (parsed.stage !== expectedStage) continue;
      if (parsed.ok === true && parsed.skipped !== true) return;
      throw new HermesInstallerError("failed", `Hermes 安装阶段 ${expectedStage} 未完成：${String(parsed.reason ?? "未知错误")}`);
    } catch (error) {
      if (error instanceof HermesInstallerError) throw error;
    }
  }
  throw new HermesInstallerError("failed", `Hermes 安装阶段 ${expectedStage} 没有返回可信的完成状态。`);
}

function normalizePathForComparison(value: string, platform: string): string {
  const platformPath = platform === "win32" ? path.win32 : path;
  const normalized = platformPath.resolve(String(value ?? "")).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function detectLinuxLibc(): HermesUvLibc {
  if (process.platform !== "linux") return "gnu";
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header?.glibcVersionRuntime) return "gnu";
  } catch {
    // Fall through to filesystem detection.
  }
  return fs.existsSync("/etc/alpine-release") ? "musl" : "gnu";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  if (source.url !== HERMES_UNIX_INSTALL_URL && source.url !== HERMES_WINDOWS_INSTALL_URL) {
    throw new HermesInstallerError("download", "Hermes 安装器来源不在允许列表中。");
  }
  return downloadPinnedArtifact(source, fetcher, externalSignal, timeoutMs, maxBytes, "error", "Hermes 安装器");
}

async function downloadPinnedUv(
  source: HermesUvAsset,
  fetcher: HermesInstallerFetch,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  maxBytes: number
): Promise<Buffer> {
  const pinned = Object.values(HERMES_UV_ASSETS).some((asset) => (
    asset.url === source.url
      && asset.sha256 === source.sha256
      && asset.expectedBytes === source.expectedBytes
      && asset.filename === source.filename
  ));
  if (!pinned || !source.url.startsWith(`${HERMES_UV_RELEASE_BASE_URL}/`)) {
    throw new HermesInstallerError("download", "uv 资产来源不在固定允许列表中。");
  }
  return downloadPinnedArtifact(source, fetcher, externalSignal, timeoutMs, maxBytes, "follow", "固定 uv 资产", source.expectedBytes);
}

async function downloadPinnedArtifact(
  source: { url: string; sha256: string },
  fetcher: HermesInstallerFetch,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  maxBytes: number,
  redirect: "error" | "follow",
  label: string,
  expectedBytes?: number
): Promise<Buffer> {
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
      response = await fetcher(source.url, { method: "GET", redirect, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new HermesInstallerError("timeout", `下载${label}超时，请检查网络后重试。`);
      if (externalSignal?.aborted) throw abortError();
      throw new HermesInstallerError("download", `下载${label}失败：${safeErrorText(error)}`);
    }
    if (!response.ok) {
      controller.abort();
      throw new HermesInstallerError("download", `Hermes 官方服务器返回 HTTP ${response.status}。`);
    }
    const declaredLength = Number(response.headers?.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      controller.abort();
      throw new HermesInstallerError("download-too-large", `${label}超过允许的下载大小。`);
    }
    if (expectedBytes !== undefined && declaredLength > 0 && declaredLength !== expectedBytes) {
      controller.abort();
      throw new HermesInstallerError("integrity", `${label}大小与固定资产不符，已拒绝执行。`);
    }
    const body = await readBoundedBody(response, maxBytes, controller, label);
    if (expectedBytes !== undefined && body.byteLength !== expectedBytes) {
      throw new HermesInstallerError("integrity", `${label}大小与固定资产不符，已拒绝执行。`);
    }
    if (label === "Hermes 安装器") return verifyHermesInstallerBytes(body, source.sha256, maxBytes);
    const actualHash = createHash("sha256").update(body).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || actualHash !== source.sha256) {
      throw new HermesInstallerError("integrity", `${label}完整性校验失败，已拒绝执行。`);
    }
    return body;
  } catch (error) {
    if (timedOut) throw new HermesInstallerError("timeout", `下载${label}超时，请检查网络后重试。`);
    if (externalSignal?.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function readBoundedBody(
  response: HermesInstallerFetchResponse,
  maxBytes: number,
  controller: AbortController,
  label = "Hermes 安装器"
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const append = (value: Uint8Array) => {
    total += value.byteLength;
    if (total > maxBytes) throw new HermesInstallerError("download-too-large", `${label}超过允许的下载大小。`);
    chunks.push(Buffer.from(value));
  };
  const reader = response.body?.getReader?.();
  if (reader) {
    let completed = false;
    try {
      while (true) {
        throwIfAborted(controller.signal);
        const part = await reader.read();
        if (part.done) {
          completed = true;
          break;
        }
        if (part.value) append(part.value);
      }
      return Buffer.concat(chunks, total);
    } finally {
      if (!completed) {
        controller.abort();
        await reader.cancel?.().catch(() => undefined);
      }
      reader.releaseLock?.();
    }
  }
  const asyncIterator = response.body?.[Symbol.asyncIterator]?.();
  if (asyncIterator) {
    let completed = false;
    try {
      while (true) {
        throwIfAborted(controller.signal);
        const part = await asyncIterator.next();
        if (part.done) {
          completed = true;
          break;
        }
        append(part.value);
      }
      return Buffer.concat(chunks, total);
    } finally {
      if (!completed) {
        controller.abort();
        await asyncIterator.return?.();
      }
    }
  }
  throw new HermesInstallerError("download", `${label}响应不支持受限流式读取，已拒绝缓冲整个响应。`);
}

function defaultFetch(url: string, init: { method: "GET"; redirect: "error" | "follow"; signal: AbortSignal }): Promise<HermesInstallerFetchResponse> {
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
  if (kind === "dependency") return "系统缺少 Hermes 安装所需的 Git、归档工具或 PowerShell。EchoInk 不会自动安装系统依赖，请补齐后重试。";
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
