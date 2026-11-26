import { getDesktopPath, getDesktopOs } from "../platform/desktop-paths";
import { getDesktopFsPromises, getDesktopFs } from "../platform/desktop-filesystem";

import { getDesktopChildProcess } from "../platform/desktop-process";

const { execFile } = getDesktopChildProcess();

const path = getDesktopPath();
const { access, realpath } = getDesktopFsPromises();
const { constants } = getDesktopFs();
const { homedir } = getDesktopOs();

export interface ObsidianCliProcessResult {
  status: "completed" | "failed" | "cancelled" | "truncated" | "unavailable";
  output: string;
  reason?: string;
  started: boolean;
}
export interface ObsidianCliTransport {
  run(argv: readonly string[], signal?: AbortSignal): Promise<ObsidianCliProcessResult>;
}
export const OBSIDIAN_CLI_RAW_CONTENT_COMMANDS: readonly string[] = Object.freeze([
  "read", "daily:read", "template:read", "history:read", "search:context", "diff", "property:read", "properties", "outline", "base:query", "aliases"
]);
export function obsidianCliOutputIsNotEnabled(command: string, output: string): boolean {
  return !OBSIDIAN_CLI_RAW_CONTENT_COMMANDS.includes(command)
    && /^(?:Command line interface is not enabled|CLI is not enabled)/iu.test(output);
}
export function obsidianCliOutputIsError(command: string, stdout: string, stderr: string): boolean {
  const rawContent = OBSIDIAN_CLI_RAW_CONTENT_COMMANDS.includes(command);
  return obsidianCliOutputIsNotEnabled(command, stdout)
    || (!rawContent && /^(?:Error:|Unknown command|Command not found)/iu.test(stdout)) || !!stderr.trim();
}
/** Fixed official installation/registration locations. Never resolve arbitrary PATH programs. */
export async function findObsidianCliExecutable(): Promise<string | null> {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Obsidian.app/Contents/MacOS/obsidian-cli", "/usr/local/bin/obsidian"]
    : process.platform === "win32"
      ? [path.join(path.dirname(process.execPath), "Obsidian.com")]
      : [path.join(path.dirname(process.execPath), "obsidian-cli"), path.join(homedir(), ".local/bin/obsidian")];
  for (const candidate of candidates) {
    // A macOS registered command must point at the official dedicated binary.
    if (process.platform === "darwin" && candidate === "/usr/local/bin/obsidian") {
      try { if (!/^\/.*\/Obsidian\.app\/Contents\/MacOS\/obsidian-cli$/u.test(await realpath(candidate))) continue; } catch { continue; }
    }
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next official location. */ }
  }
  return null;
}
export function createOfficialObsidianCliTransport(vaultRootPath: string, options: {
  findExecutable?: typeof findObsidianCliExecutable;
  executeFile?: typeof execFile;
  timeoutMs?: number;
} = {}): ObsidianCliTransport {
  return {
    async run(argv, signal) {
      return await new Promise<ObsidianCliProcessResult>((resolve) => {
        let child: ReturnType<typeof execFile> | undefined;
        let started = false;
        let settled = false;
        const finish = (result: ObsidianCliProcessResult) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          resolve(result);
        };
        const stop = (status: "failed" | "cancelled", reason: string) => {
          finish({ status, started, output: "", reason });
          // Return even if the child never closes or the execFile callback never runs.
          try { child?.kill("SIGKILL"); } catch { /* The process may have already exited. */ }
          child?.stdout?.destroy();
          child?.stderr?.destroy();
        };
        const cancel = () => stop("cancelled", "obsidian_cli_cancelled");
        const timer = window.setTimeout(() => stop("failed", "obsidian_cli_timeout"), options.timeoutMs ?? 20_000);
        if (signal?.aborted) { cancel(); return; }
        signal?.addEventListener("abort", cancel, { once: true });

        void (async () => {
          try {
            const executable = await (options.findExecutable ?? findObsidianCliExecutable)();
            if (settled) return;
            if (!executable) {
              finish({ status: "unavailable", started, output: "", reason: "Obsidian CLI binary missing. Install Obsidian 1.12.7+ and enable Settings > General > Advanced > Command line interface." });
              return;
            }
            // Public CLI selects the Vault containing cwd, which the caller verifies.
            child = (options.executeFile ?? execFile)(executable, [...argv], {
              cwd: vaultRootPath, shell: false, windowsHide: true, maxBuffer: 32_000, encoding: "utf8"
            }, (error, stdout, stderr) => {
              if (settled) return;
              const output = stdout.slice(0, 32_000);
              if (error) {
                finish({ status: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "truncated" : "failed", started, output, reason: "obsidian_cli_process_failed" });
              } else if (obsidianCliOutputIsError(argv[0] ?? "", stdout, stderr)) {
                finish({ status: "failed", started, output, reason: "obsidian_cli_reported_error" });
              } else finish({ status: "completed", started, output });
            });
            child.once("spawn", () => { started = true; });
          } catch {
            finish({ status: "failed", started, output: "", reason: "obsidian_cli_process_failed" });
          }
        })();
      });
    }
  };
}
