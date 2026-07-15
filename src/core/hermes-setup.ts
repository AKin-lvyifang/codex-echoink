import { execFile } from "child_process";

export const HERMES_NOUS_PROVIDER = "nous";
export const HERMES_NOUS_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
export const HERMES_NOUS_AUTH_ARGS = ["auth", "add", HERMES_NOUS_PROVIDER, "--type", "oauth", "--timeout", "180"] as const;

export interface HermesSetupRunnerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBuffer: number;
  shell: false;
}

export type HermesSetupRunner = (
  command: string,
  args: readonly string[],
  options: HermesSetupRunnerOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface HermesNousAuthorizationOptions {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  runner?: HermesSetupRunner;
  timeoutMs?: number;
}

export interface HermesNousAuthorizationResult {
  status: "authorized" | "cancelled" | "failed";
  providerId: string;
  modelId: string;
  logs: string;
  error?: string;
}

export async function authorizeHermesNous(options: HermesNousAuthorizationOptions): Promise<HermesNousAuthorizationResult> {
  const runner = options.runner ?? defaultRunner;
  const runnerOptions: HermesSetupRunnerOptions = {
    cwd: options.cwd,
    env: { ...process.env, PATH: process.env.PATH ?? "" },
    signal: options.signal,
    timeoutMs: Math.max(30_000, options.timeoutMs ?? 5 * 60_000),
    maxBuffer: 1024 * 1024,
    shell: false
  };
  try {
    const auth = await runner(options.command, HERMES_NOUS_AUTH_ARGS, runnerOptions);
    if (!/saved|added|imported|login successful|credentials/i.test(`${auth.stdout}\n${auth.stderr}`)) {
      throw new Error("Nous Portal 没有返回授权成功状态。");
    }
    await runner(options.command, ["config", "set", "model.provider", HERMES_NOUS_PROVIDER], runnerOptions);
    await runner(options.command, ["config", "set", "model.default", HERMES_NOUS_DEFAULT_MODEL], runnerOptions);
    return {
      status: "authorized",
      providerId: HERMES_NOUS_PROVIDER,
      modelId: HERMES_NOUS_DEFAULT_MODEL,
      logs: limitedHermesSetupLog(`${auth.stdout}\n${auth.stderr}`)
    };
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      return { status: "cancelled", providerId: "", modelId: "", logs: "", error: "授权已取消" };
    }
    return {
      status: "failed",
      providerId: "",
      modelId: "",
      logs: limitedHermesSetupLog(error instanceof Error ? error.message : String(error)),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function limitedHermesSetupLog(value: string, maxChars = 8_000): string {
  const text = String(value ?? "")
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9._~-]{8,}\b/g, "[已隐藏凭据]")
    .replace(/((?:api[_-]?key|authorization|token|device[_-]?code)\s*[:=]\s*)([^\s]+)/gi, "$1[已隐藏]")
    .trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…`;
}

function defaultRunner(command: string, args: readonly string[], options: HermesSetupRunnerOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      shell: false
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error([error.message, stderr].filter(Boolean).join("\n")));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.stdin?.end();
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel|取消/i.test(error.message));
}
