import { spawn, type ChildProcess } from "child_process";
import { parseOpenCodeRunJsonLines } from "./opencode-run";

export interface RunOpenCodeCommandInput {
  command: string;
  argsPrefix?: string[];
  args: string[];
  cwd: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
  onSpawn?: (child: ChildProcess) => void;
  killGraceMs?: number;
}

export async function runOpenCodeCommand(input: RunOpenCodeCommandInput): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(input.command, [...(input.argsPrefix ?? []), ...input.args], {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.abortSignal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const abort = () => {
      stopOpenCodeProcess(child, input.killGraceMs);
      finish(new Error("Agent 任务已取消。"));
    };
    child.once("spawn", () => {
      try {
        input.onSpawn?.(child);
      } catch (error) {
        stopOpenCodeProcess(child, input.killGraceMs);
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    timer = input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => {
        stopOpenCodeProcess(child, input.killGraceMs);
        finish(new Error(`OpenCode CLI 执行超时：${input.timeoutMs}ms`));
      }, input.timeoutMs)
      : null;
    if (input.abortSignal?.aborted) abort();
    else input.abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      const value = chunk.toString();
      stdout += value;
      input.onStdoutChunk?.(value);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const parsedError = parseOpenCodeRunFailure(stdout);
      finish(new Error(parsedError || `OpenCode CLI 已退出：${code ?? signal ?? "unknown"}${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

export function stopOpenCodeProcess(proc: ChildProcess, graceMs = 1500): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const pid = proc.pid;
  if (typeof pid === "number" && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
      scheduleForceKill(() => process.kill(-pid, "SIGKILL"), graceMs);
      return;
    } catch {
      // The child may not own a process group; kill it directly below.
    }
  }
  try {
    proc.kill("SIGTERM");
  } finally {
    scheduleForceKill(() => proc.kill("SIGKILL"), graceMs);
  }
}

function scheduleForceKill(kill: () => unknown, graceMs: number): void {
  const timer = globalThis.setTimeout(() => {
    try {
      kill();
    } catch {
      // The process already exited.
    }
  }, Math.max(0, graceMs));
  timer.unref?.();
}

function parseOpenCodeRunFailure(output: string): string {
  try {
    parseOpenCodeRunJsonLines(output);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}
