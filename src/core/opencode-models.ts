import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "node:url";
import type { Agent, FilePartInput, Model, Provider, TextPartInput } from "@opencode-ai/sdk/v2";
import type { AgentInputModality, AgentModelInfo, AgentProfileInfo, AgentPromptPart } from "../agent/types";
import { expandHome } from "./path-utils";
import { resolveWindowsOpenCodeLaunch, splitWindowsPath, type SafeCliLaunch } from "./windows-cli-launch";

export interface OpenCodeCommandResolveOptions {
  home?: string;
  envPath?: string;
  platform?: NodeJS.Platform | string;
  arch?: string;
  appData?: string;
  programData?: string;
  systemRoot?: string;
  exists?: (candidate: string) => boolean;
}

export type OpenCodeCommandLaunch = SafeCliLaunch;

export function detectOpenCodeCommand(customPath: string, options: OpenCodeCommandResolveOptions = {}): string | null {
  const home = options.home ?? os.homedir();
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const platform = options.platform ?? process.platform;
  const custom = customPath.trim();
  if (custom) {
    const expanded = expandHome(custom, home);
    const resolved = normalizeOpenCodeCandidate(expanded, platform, exists, options.systemRoot, options.arch);
    if (resolved) return resolved;
  }
  for (const candidate of openCodeCommandCandidates(
    home,
    options.envPath ?? process.env.PATH ?? "",
    platform,
    options.appData ?? process.env.APPDATA ?? "",
    options.programData ?? process.env.ProgramData ?? "C:\\ProgramData"
  )) {
    const resolved = normalizeOpenCodeCandidate(candidate, platform, exists, options.systemRoot, options.arch);
    if (resolved) return resolved;
  }
  return null;
}

export function resolveOpenCodeCommand(customPath: string, options: OpenCodeCommandResolveOptions = {}): string {
  const command = detectOpenCodeCommand(customPath, options);
  if (command) return command;
  const expanded = customPath.trim() ? expandHome(customPath.trim(), options.home ?? os.homedir()) : "opencode";
  throw new Error(`找不到 OpenCode CLI：${expanded}。请先安装 OpenCode，或在设置里填写正确路径。`);
}

export function resolveOpenCodeLaunch(customPath: string, options: OpenCodeCommandResolveOptions = {}): OpenCodeCommandLaunch {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const command = resolveOpenCodeCommand(customPath, options);
  if (platform !== "win32") return { command, argsPrefix: [], resolvedPath: command };
  const launch = resolveWindowsOpenCodeLaunch(command, exists, options.systemRoot, options.arch ?? process.arch);
  if (launch) return launch;
  throw new Error(`OpenCode CLI 无法安全启动：${command}。Windows 需要官方 opencode.exe 或可由系统 PowerShell 直接执行的 opencode.ps1。`);
}

export function openCodeCommandCandidates(home: string, envPath: string, platform: NodeJS.Platform | string = process.platform, appData = process.env.APPDATA ?? "", programData = process.env.ProgramData ?? "C:\\ProgramData"): string[] {
  const windowsCandidates = platform === "win32"
    ? [
      path.win32.join(home, ".opencode", "bin", "opencode.exe"),
      path.win32.join(home, ".opencode", "bin", "opencode.ps1"),
      path.win32.join(home, ".opencode", "bin", "opencode.cmd"),
      path.win32.join(home, ".npm-global", "opencode.ps1"),
      path.win32.join(home, ".npm-global", "opencode.cmd"),
      appData ? path.win32.join(appData, "npm", "opencode.ps1") : "",
      appData ? path.win32.join(appData, "npm", "opencode.cmd") : "",
      path.win32.join(home, "scoop", "shims", "opencode.cmd"),
      path.win32.join(home, "scoop", "shims", "opencode.ps1"),
      path.win32.join(programData, "chocolatey", "bin", "opencode.exe")
    ].filter(Boolean)
    : [];
  if (platform === "win32") {
    return [
      ...windowsCandidates,
      ...splitWindowsPath(envPath).flatMap((directory) => [
        path.win32.join(directory, "opencode.exe"),
        path.win32.join(directory, "opencode.ps1"),
        path.win32.join(directory, "opencode.cmd")
      ])
    ];
  }
  return [
    path.join(home, ".opencode", "bin", "opencode"),
    path.join(home, ".npm-global", "bin", "opencode"),
    path.join(home, ".bun", "bin", "opencode"),
    path.join(home, ".local", "bin", "opencode"),
    ...windowsCandidates,
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    ...String(envPath || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((part) => path.join(part, "opencode"))
  ];
}

function normalizeOpenCodeCandidate(
  candidate: string,
  platform: NodeJS.Platform | string,
  exists: (candidate: string) => boolean,
  systemRoot?: string,
  arch?: string
): string | null {
  if (!exists(candidate)) return null;
  if (platform !== "win32") return candidate;
  return resolveWindowsOpenCodeLaunch(candidate, exists, systemRoot, arch ?? process.arch)?.resolvedPath ?? null;
}

export function normalizeOpenCodeServerUrl(serverUrl: string, hostname: string, port: number): string {
  const explicit = serverUrl.trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `http://${hostname || "127.0.0.1"}:${port || 4096}`;
}

export function modelSupportsInput(model: Pick<Model, "capabilities"> | null | undefined, modality: AgentInputModality): boolean {
  if (!model) return modality === "text";
  return Boolean(model.capabilities?.input?.[modality]);
}

export function modelInputModalities(model: Pick<Model, "capabilities"> | null | undefined): AgentInputModality[] {
  const modalities: AgentInputModality[] = [];
  if (modelSupportsInput(model, "text")) modalities.push("text");
  if (modelSupportsInput(model, "image")) modalities.push("image");
  if (modelSupportsInput(model, "pdf")) modalities.push("pdf");
  return modalities.length ? modalities : ["text"];
}

export function flattenOpenCodeModels(providers: Provider[]): AgentModelInfo[] {
  const models: AgentModelInfo[] = [];
  for (const provider of providers) {
    for (const model of Object.values(provider.models ?? {})) {
      const id = model.id.startsWith(`${provider.id}/`) ? model.id : `${provider.id}/${model.id}`;
      models.push({
        id,
        providerId: provider.id,
        modelId: model.id,
        displayName: `${provider.name || provider.id} · ${model.name || model.id}`,
        inputModalities: modelInputModalities(model)
      });
    }
  }
  return models.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function flattenOpenCodeAgents(agents: Agent[]): AgentProfileInfo[] {
  const visibleAgents = agents
    .map((agent) => ({
      id: agent.name,
      name: agent.name,
      displayName: agent.name,
      description: agent.description,
      mode: agent.mode,
      native: agent.native,
      hidden: agent.hidden
    }))
    .filter((agent) => agent.name && !agent.hidden);
  const runnableAgents = visibleAgents.filter((agent) => agent.mode !== "subagent");
  return (runnableAgents.length ? runnableAgents : visibleAgents)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function mimeForKnowledgeFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

export function requiredModalityForMime(mime: string): AgentInputModality {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  return "text";
}

export function toOpenCodeFilePart(filePath: string, mime = mimeForKnowledgeFile(filePath)): FilePartInput {
  return {
    type: "file",
    mime,
    filename: path.basename(filePath),
    url: pathToFileURL(filePath).href
  };
}

export function ensureOpenCodeModelSupportsFiles(model: AgentModelInfo | null, parts: AgentPromptPart[]): void {
  const missing = new Set<AgentInputModality>();
  for (const part of parts) {
    if (part.type !== "file") continue;
    const modality = requiredModalityForMime(part.mime);
    if (!model?.inputModalities.includes(modality)) missing.add(modality);
  }
  if (!missing.size) return;
  throw new Error(`当前 OpenCode 模型不支持 ${Array.from(missing).join(" / ")} 输入，请切换支持多模态的模型。`);
}

export function selectOpenCodeModelForTask(
  models: AgentModelInfo[],
  providerId: string,
  modelId: string,
  required: AgentInputModality[]
): AgentModelInfo | null {
  const configured = models.find((model) => model.providerId === providerId && model.modelId === modelId);
  if (configured) return configured;
  const capable = models.filter((model) => required.every((modality) => model.inputModalities.includes(modality)));
  return capable.find((model) => model.providerId === "opencode")
    ?? capable[0]
    ?? models.find((model) => model.providerId === "opencode")
    ?? models[0]
    ?? null;
}

export function selectOpenCodeSetupModel(models: AgentModelInfo[]): AgentModelInfo | null {
  return models.find((model) => model.id === "opencode/deepseek-v4-flash-free" || model.modelId === "opencode/deepseek-v4-flash-free")
    ?? models.find((model) => model.providerId === "opencode" && /(?:^|[-_/])free(?:$|[-_/])/i.test(model.id))
    ?? null;
}

export function selectOpenCodeConnectionModel(
  models: AgentModelInfo[],
  configured: { providerId: string; modelId: string }
): AgentModelInfo | null {
  const providerId = configured.providerId.trim();
  const modelId = configured.modelId.trim();
  const exact = models.find((model) => {
    const providerMatches = !providerId || model.providerId === providerId;
    const modelMatches = !modelId || model.modelId === modelId || model.id === modelId;
    return providerMatches && modelMatches;
  });
  if (exact && (providerId || modelId)) return exact;
  // A configured model is user-owned state. If it disappeared from the
  // provider catalogue, stop and ask the user instead of silently replacing
  // it with whichever model happens to be listed first.
  if (modelId) return null;
  if (providerId) return models.find((model) => model.providerId === providerId) ?? null;
  return selectOpenCodeSetupModel(models);
}

export function toOpenCodePromptPart(part: AgentPromptPart): TextPartInput | FilePartInput {
  if (part.type === "text") return { type: "text", text: part.text };
  return toOpenCodeFilePart(part.path, part.mime);
}
