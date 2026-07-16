import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export const HERMES_NOUS_PROVIDER = "nous";
export const HERMES_NOUS_AUTH_ARGS = ["auth", "add", HERMES_NOUS_PROVIDER, "--type", "oauth", "--timeout", "180"] as const;
export const HERMES_NOUS_RECOMMENDED_MODELS_URL = "https://portal.nousresearch.com/api/nous/recommended-models";
export const HERMES_NOUS_MODEL_CATALOG_MAX_BYTES = 256 * 1024;
export const HERMES_CONFIG_MAX_BYTES = 256 * 1024;

interface HermesNousCatalogResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: {
    getReader(): {
      read(): Promise<ReadableStreamReadResult<Uint8Array>>;
      cancel(reason?: unknown): Promise<void>;
      releaseLock(): void;
    };
  } | null;
}

export type HermesNousCatalogFetch = (
  url: string,
  init: { method: "GET"; redirect: "error"; signal: AbortSignal }
) => Promise<HermesNousCatalogResponse>;

export interface HermesNousCatalogOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: HermesNousCatalogFetch;
}

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

export interface HermesConfigFileStat {
  size: number;
  isFile(): boolean;
}

export interface HermesConfigFileAccess {
  stat(filePath: string): Promise<HermesConfigFileStat>;
  realpath(filePath: string): Promise<string>;
  readFile(filePath: string): Promise<Buffer | string>;
}

export interface HermesModelConfigSnapshot {
  configPath: string | null;
  provider: string | null;
  defaultModel: string | null;
  hasExistingModelConfig: boolean;
}

export interface HermesModelConfigInspectionOptions {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  runner?: HermesSetupRunner;
  timeoutMs?: number;
  homeDir?: string;
  maxBytes?: number;
  fileAccess?: HermesConfigFileAccess;
}

export type HermesModelConfigInspector = (
  options: HermesModelConfigInspectionOptions
) => Promise<HermesModelConfigSnapshot>;

export interface HermesNousAuthorizationOptions {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  runner?: HermesSetupRunner;
  timeoutMs?: number;
  resolveModel?: (signal?: AbortSignal) => Promise<string>;
  inspectModelConfig?: HermesModelConfigInspector;
  configFileAccess?: HermesConfigFileAccess;
  homeDir?: string;
  configMaxBytes?: number;
}

export interface HermesNousAuthorizationResult {
  status: "authorized" | "cancelled" | "failed";
  providerId: string;
  modelId: string;
  logs: string;
  error?: string;
}

export async function inspectHermesModelConfig(
  options: HermesModelConfigInspectionOptions
): Promise<HermesModelConfigSnapshot> {
  const runner = options.runner ?? defaultRunner;
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const runnerOptions: HermesSetupRunnerOptions = {
    cwd: options.cwd,
    env: { ...process.env, HOME: homeDir, PATH: process.env.PATH ?? "" },
    signal: options.signal,
    timeoutMs: Math.min(30_000, Math.max(5_000, options.timeoutMs ?? 30_000)),
    maxBuffer: 16 * 1024,
    shell: false
  };
  const output = await runner(options.command, ["config", "path"], runnerOptions);
  const configPath = parseHermesConfigPath(output.stdout, homeDir);
  const fileAccess = options.fileAccess ?? defaultHermesConfigFileAccess;
  let realConfigPath: string;
  try {
    realConfigPath = await fileAccess.realpath(configPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { configPath, provider: null, defaultModel: null, hasExistingModelConfig: false };
    }
    throw error;
  }
  if (!isPathInside(homeDir, realConfigPath)) throw new Error("Hermes 配置路径必须位于当前用户目录内");
  let fileStat: HermesConfigFileStat;
  try {
    fileStat = await fileAccess.stat(realConfigPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { configPath, provider: null, defaultModel: null, hasExistingModelConfig: false };
    }
    throw error;
  }
  if (!fileStat.isFile()) throw new Error("Hermes 配置路径不是普通文件");
  const maxBytes = Math.min(HERMES_CONFIG_MAX_BYTES, Math.max(1_024, options.maxBytes ?? HERMES_CONFIG_MAX_BYTES));
  if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0 || fileStat.size > maxBytes) {
    throw new Error("Hermes 配置文件超过安全大小限制");
  }
  const raw = await fileAccess.readFile(realConfigPath);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
  if (bytes.byteLength > maxBytes) throw new Error("Hermes 配置文件超过安全大小限制");
  const configText = bytes.toString("utf8");
  const model = parseHermesModelConfigYaml(configText);
  return {
    configPath: realConfigPath,
    provider: model.provider,
    defaultModel: model.defaultModel,
    hasExistingModelConfig: Boolean(model.provider || model.defaultModel || hasNonEmptyHermesModelSection(configText))
  };
}

export function parseHermesModelConfigYaml(value: string): Pick<HermesModelConfigSnapshot, "provider" | "defaultModel"> {
  let inModel = false;
  let modelChildIndent: number | null = null;
  let provider: string | null = null;
  let defaultModel: string | null = null;

  for (const rawLine of String(value ?? "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const content = rawLine.slice(indent);
    if (indent === 0) {
      const modelMatch = content.match(/^model\s*:\s*(.*)$/);
      if (!modelMatch) {
        inModel = false;
        modelChildIndent = null;
        continue;
      }
      inModel = true;
      modelChildIndent = null;
      const inlineModel = modelMatch[1].trim();
      if (inlineModel.startsWith("{") && inlineModel.endsWith("}")) {
        const inline = parseHermesInlineModel(inlineModel.slice(1, -1));
        provider = inline.provider;
        defaultModel = inline.defaultModel;
        inModel = false;
      }
      continue;
    }
    if (!inModel) continue;
    if (modelChildIndent === null) modelChildIndent = indent;
    if (indent !== modelChildIndent) continue;
    const child = content.match(/^(provider|default)\s*:\s*(.*)$/);
    if (!child) continue;
    const parsed = parseYamlScalar(child[2]);
    if (child[1] === "provider") provider = parsed;
    else defaultModel = parsed;
  }
  return { provider, defaultModel };
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
    const inspectModelConfig = options.inspectModelConfig ?? inspectHermesModelConfig;
    const currentConfig = await inspectModelConfig({
      command: options.command,
      cwd: options.cwd,
      signal: options.signal,
      runner,
      timeoutMs: options.timeoutMs,
      homeDir: options.homeDir,
      maxBytes: options.configMaxBytes,
      fileAccess: options.configFileAccess
    });
    const hasExistingModelConfig = currentConfig.hasExistingModelConfig
      || Boolean(currentConfig.provider || currentConfig.defaultModel);
    // `model.provider` is written first. If the following model write fails,
    // this exact shape is safe to resume without replacing another provider.
    const canResumeIncompleteNousConfig = currentConfig.provider === HERMES_NOUS_PROVIDER
      && !currentConfig.defaultModel;
    const hasDifferentProvider = Boolean(
      currentConfig.provider && currentConfig.provider !== HERMES_NOUS_PROVIDER
    );
    if (hasDifferentProvider || (hasExistingModelConfig && !canResumeIncompleteNousConfig)) {
      const configuredKeys = [
        currentConfig.provider ? "model.provider" : "",
        currentConfig.defaultModel ? "model.default" : ""
      ].filter(Boolean).join("、");
      throw new Error(`检测到已有 Hermes 模型配置（${configuredKeys}），已保留原配置。`);
    }
    const auth = await runner(options.command, HERMES_NOUS_AUTH_ARGS, runnerOptions);
    if (!/saved|added|imported|login successful|credentials/i.test(`${auth.stdout}\n${auth.stderr}`)) {
      throw new Error("Nous Portal 没有返回授权成功状态。");
    }
    const modelId = await (options.resolveModel
      ? options.resolveModel(options.signal)
      : fetchHermesNousRecommendedModel({ signal: options.signal }));
    if (options.signal?.aborted) {
      const aborted = new Error("授权已取消");
      aborted.name = "AbortError";
      throw aborted;
    }
    // OAuth can take several minutes. Re-read the user-owned model config at
    // the last responsible moment so a concurrent edit is never overwritten.
    const latestConfig = await inspectModelConfig({
      command: options.command,
      cwd: options.cwd,
      signal: options.signal,
      runner,
      timeoutMs: options.timeoutMs,
      homeDir: options.homeDir,
      maxBytes: options.configMaxBytes,
      fileAccess: options.configFileAccess
    });
    const latestHasModelConfig = latestConfig.hasExistingModelConfig
      || Boolean(latestConfig.provider || latestConfig.defaultModel);
    const latestCanResumeNous = latestConfig.provider === HERMES_NOUS_PROVIDER
      && !latestConfig.defaultModel;
    if (latestHasModelConfig && !latestCanResumeNous) {
      if (latestConfig.provider === HERMES_NOUS_PROVIDER && latestConfig.defaultModel === modelId) {
        return {
          status: "authorized",
          providerId: HERMES_NOUS_PROVIDER,
          modelId,
          logs: "Nous Portal 授权已完成。"
        };
      }
      throw new Error("授权期间 Hermes 模型配置发生变化，已保留当前配置。请重新检测后继续。");
    }
    if (latestConfig.provider !== HERMES_NOUS_PROVIDER) {
      await runner(options.command, ["config", "set", "model.provider", HERMES_NOUS_PROVIDER], runnerOptions);
    }
    await runner(options.command, ["config", "set", "model.default", modelId], runnerOptions);
    return {
      status: "authorized",
      providerId: HERMES_NOUS_PROVIDER,
      modelId,
      logs: "Nous Portal 授权已完成。"
    };
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      return { status: "cancelled", providerId: "", modelId: "", logs: "", error: "授权已取消" };
    }
    const safeError = limitedHermesSetupLog(error instanceof Error ? error.message : String(error));
    return {
      status: "failed",
      providerId: "",
      modelId: "",
      logs: safeError,
      error: safeError
    };
  }
}

export function selectHermesNousRecommendedModel(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["freeRecommendedModels", "paidRecommendedModels"] as const) {
    const models = record[key];
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const modelName = (model as Record<string, unknown>).modelName;
      if (typeof modelName === "string" && modelName.trim()) return modelName.trim();
    }
  }
  return null;
}

export async function fetchHermesNousRecommendedModel(options: HermesNousCatalogOptions = {}): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1_000, options.timeoutMs ?? 15_000));
  const maxBytes = Math.min(
    HERMES_NOUS_MODEL_CATALOG_MAX_BYTES,
    Math.max(1_024, options.maxBytes ?? HERMES_NOUS_MODEL_CATALOG_MAX_BYTES)
  );
  try {
    const fetcher = options.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<HermesNousCatalogResponse>);
    const response = await fetcher(HERMES_NOUS_RECOMMENDED_MODELS_URL, {
      method: "GET",
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Nous Portal 模型目录返回 HTTP ${response.status}`);
    const declaredLength = Number(response.headers?.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      controller.abort();
      throw new Error("Nous Portal 模型目录超过安全大小限制");
    }
    const body = await readBoundedHermesNousCatalog(response, maxBytes, controller);
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("Nous Portal 模型目录不是有效 JSON");
    }
    const modelId = selectHermesNousRecommendedModel(payload);
    if (!modelId) throw new Error("Nous Portal 模型目录没有可用的推荐模型");
    return modelId;
  } catch (error) {
    if (options.signal?.aborted) {
      const aborted = new Error("授权已取消");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (timedOut) throw new Error("读取 Nous Portal 模型目录超时");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function readBoundedHermesNousCatalog(
  response: HermesNousCatalogResponse,
  maxBytes: number,
  controller: AbortController
): Promise<Buffer> {
  if (!response.body) throw new Error("Nous Portal 模型目录无法安全流式读取");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      const value = result.value;
      if (!(value instanceof Uint8Array)) throw new Error("Nous Portal 模型目录返回了无效数据");
      if (value.byteLength > maxBytes - totalBytes) {
        controller.abort();
        throw new Error("Nous Portal 模型目录超过安全大小限制");
      }
      chunks.push(Buffer.from(value));
      totalBytes += value.byteLength;
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The request may already have been aborted by the size or timeout guard.
      }
    }
    reader.releaseLock();
  }
}

export function limitedHermesSetupLog(value: string, maxChars = 8_000): string {
  const text = String(value ?? "")
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9._~-]{8,}\b/g, "[已隐藏凭据]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [已隐藏]")
    .replace(/(["']?(?:api[ _-]?key|authorization(?:[ _-]?code)?|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|token|device[ _-]?code|user[ _-]?code|verification[ _-]?(?:url|uri)(?:[ _-]?complete)?)["']?\s*[=:]\s*["']?)([^\s,"'}]+)/gi, "$1[已隐藏]")
    .replace(/((?:device|user)[ _-]?code\s+(?:is\s+)?)([A-Z0-9][A-Z0-9_-]{3,})/gi, "$1[已隐藏]")
    .replace(/((?:enter|use)\s+(?:the\s+)?(?:user\s+)?code\s*[=:]?\s*)([A-Z0-9][A-Z0-9_-]{3,})/gi, "$1[已隐藏]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[已隐藏授权地址]")
    .trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…`;
}

const defaultHermesConfigFileAccess: HermesConfigFileAccess = {
  stat: (filePath) => fs.stat(filePath),
  realpath: (filePath) => fs.realpath(filePath),
  readFile: (filePath) => fs.readFile(filePath)
};

function parseHermesConfigPath(stdout: string, homeDir: string): string {
  const lines = stripAnsi(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error("Hermes 没有返回唯一的官方配置路径");
  const unquoted = lines[0].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
  if (!path.isAbsolute(unquoted)) throw new Error("Hermes 返回的配置路径不是绝对路径");
  const resolved = path.resolve(unquoted);
  if (!isPathInside(homeDir, resolved)) throw new Error("Hermes 配置路径必须位于当前用户目录内");
  return resolved;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseHermesInlineModel(value: string): Pick<HermesModelConfigSnapshot, "provider" | "defaultModel"> {
  let provider: string | null = null;
  let defaultModel: string | null = null;
  for (const entry of splitYamlInlineEntries(value)) {
    const match = entry.match(/^\s*(provider|default)\s*:\s*(.*)$/);
    if (!match) continue;
    const parsed = parseYamlScalar(match[2]);
    if (match[1] === "provider") provider = parsed;
    else defaultModel = parsed;
  }
  return { provider, defaultModel };
}

function hasNonEmptyHermesModelSection(value: string): boolean {
  let inModel = false;
  for (const rawLine of String(value ?? "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    if (indent === 0) {
      const modelMatch = rawLine.match(/^model\s*:\s*(.*)$/);
      if (!modelMatch) {
        inModel = false;
        continue;
      }
      inModel = true;
      const inline = parseYamlScalar(modelMatch[1]);
      if (inline && inline !== "{}") return true;
      continue;
    }
    if (inModel) return true;
  }
  return false;
}

function splitYamlInlineEntries(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quote = "";
  for (const char of value) {
    if ((char === "\"" || char === "'") && (!quote || quote === char)) quote = quote ? "" : char;
    if (char === "," && !quote) {
      entries.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  entries.push(current);
  return entries;
}

function parseYamlScalar(value: string): string | null {
  let scalar = "";
  let quote = "";
  for (const char of value.trim()) {
    if ((char === "\"" || char === "'") && (!quote || quote === char)) quote = quote ? "" : char;
    if (char === "#" && !quote && (!scalar || /\s$/.test(scalar))) break;
    scalar += char;
  }
  scalar = scalar.trim();
  const wasQuoted = (scalar.startsWith("\"") && scalar.endsWith("\"")) || (scalar.startsWith("'") && scalar.endsWith("'"));
  if (wasQuoted) {
    scalar = scalar.slice(1, -1).trim();
  }
  if (!scalar || (!wasQuoted && /^(?:null|~)$/i.test(scalar))) return null;
  return scalar;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
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
