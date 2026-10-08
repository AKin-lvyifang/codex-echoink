import * as path from "node:path";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";

export interface ObsidianCliProcessResult {
  status: "completed" | "failed" | "cancelled" | "truncated" | "unavailable";
  output: string;
  reason?: string;
  started: boolean;
}
export interface ObsidianCliTransport {
  run(argv: readonly string[], signal?: AbortSignal): Promise<ObsidianCliProcessResult>;
}
export function obsidianCliOutputIsError(command: string, stdout: string, stderr: string): boolean {
  const rawContent = ["read", "daily:read", "template:read", "history:read", "search:context", "diff", "property:read", "properties", "outline", "base:query", "aliases"].includes(command);
  return (!rawContent && /^(?:Error:|Unknown command|Command not found|CLI is not enabled)/iu.test(stdout)) || !!stderr.trim();
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
export function createOfficialObsidianCliTransport(vaultRootPath: string): ObsidianCliTransport {
  return {
    async run(argv, signal) {
      if (signal?.aborted) return { status: "cancelled", started: false, output: "", reason: "obsidian_cli_cancelled" };
      const executable = await findObsidianCliExecutable();
      if (!executable) return { status: "unavailable", started: false, output: "", reason: "Obsidian CLI binary missing. Install Obsidian 1.12.7+ and enable Settings > General > Command line interface." };
      // Obsidian's app:// renderer cannot dynamically import Node ESM modules.
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      return await new Promise<ObsidianCliProcessResult>((resolve) => {
        let started = false;
        // Public CLI selects the Vault containing cwd. The caller verifies `vault info=path`
        // before every request. A model cannot provide cwd, a program, or vault=.
        const child = execFile(executable, [...argv], {
          cwd: vaultRootPath, shell: false, windowsHide: true, timeout: 20_000,
          maxBuffer: 32_000, encoding: "utf8", ...(signal ? { signal } : {})
        }, (error, stdout, stderr) => {
          const output = stdout.slice(0, 32_000);
          if (signal?.aborted) return resolve({ status: "cancelled", started, output, reason: "obsidian_cli_cancelled" });
          if (error) return resolve({ status: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "truncated" : "failed", started, output, reason: error.killed ? "obsidian_cli_timeout" : "obsidian_cli_process_failed" });
          if (obsidianCliOutputIsError(argv[0] ?? "", stdout, stderr)) return resolve({ status: "failed", started, output, reason: "obsidian_cli_reported_error" });
          resolve({ status: "completed", started, output });
        });
        child.once("spawn", () => { started = true; });
      });
    }
  };
}
