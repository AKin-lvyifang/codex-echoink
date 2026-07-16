import type { ChatMessage, SettingsLanguage } from "../settings/settings";
import type { AgentBackendMode } from "../settings/settings";

const MISSING_CODEX_CLI_PATTERN = /(?:找不到|未找到|缺少)\s*codex\s*cli|codex\s*cli\s*(?:not found|missing)|(?:not found|missing)\s+codex\s+cli/gi;
const MISSING_OPENCODE_CLI_PATTERN = /(?:找不到|未找到|缺少)\s*opencode\s*(?:cli|命令行?|可执行文件)|opencode\s*cli\s*(?:not found|missing)|(?:not found|missing)\s+opencode\s+cli/gi;
const MISSING_HERMES_CLI_PATTERN = /(?:找不到|未找到|缺少)\s*hermes\s*(?:cli|命令行?|可执行文件)|hermes\s*cli\s*(?:not found|missing)|(?:not found|missing)\s+hermes\s+cli/gi;
const EXPLICIT_CLI_CONFIGURATION_ERROR_PATTERN = /(?:模型\s*配置|model\s+config(?:uration)?|provider\s*(?:配置|config(?:uration)?)|(?:api[ _-]*key|密钥)\s*(?:配置|config(?:uration)?)?|(?:required|missing|an?|the)\s+(?:model|provider|api[ _-]*key)\b|(?:的|所需|需要的?)\s*(?:model|provider|api[ _-]*key|模型|提供商|服务商|密钥)\s*(?:配置)?)/i;
const CONFIGURATION_SUFFIX_PATTERN = /^[\s:：,，。.!！?？;；-]*(?:(?:的|所需|需要的?|required|an?|the)\s*)*(?:(?:model|provider|config(?:uration)?|api[ _-]*key)\b|模型|提供商|服务商|配置|密钥)/i;
const SPAWN_EXECUTABLE_PATTERN = /\bspawn[ \t]+([^\r\n]+?)[ \t]+enoent\b/gi;
const SPAWN_EXECUTABLE_EXTENSION_PATTERN = /\.(?:cmd|exe|ps1|bat)$/i;
const SPAWN_EXECUTABLE_BACKENDS: Readonly<Record<string, AgentBackendMode>> = {
  codex: "codex-cli",
  opencode: "opencode",
  hermes: "hermes"
};

function backendFromMissingSpawn(text: string): AgentBackendMode | null {
  SPAWN_EXECUTABLE_PATTERN.lastIndex = 0;
  for (let match = SPAWN_EXECUTABLE_PATTERN.exec(text); match; match = SPAWN_EXECUTABLE_PATTERN.exec(text)) {
    const rawExecutable = match[1].trim();
    const quote = rawExecutable[0];
    const executable = (quote === '"' || quote === "'" || quote === "`") && rawExecutable.endsWith(quote)
      ? rawExecutable.slice(1, -1).trim()
      : rawExecutable;
    const basename = executable.split(/[\\/]/).pop()?.trim() ?? "";
    const normalizedBasename = basename.replace(SPAWN_EXECUTABLE_EXTENSION_PATTERN, "").toLowerCase();
    const backend = SPAWN_EXECUTABLE_BACKENDS[normalizedBasename];
    if (backend) return backend;
  }
  return null;
}

function hasMissingCliMessage(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const suffix = text.slice(match.index + match[0].length);
    if (!CONFIGURATION_SUFFIX_PATTERN.test(suffix)) return true;
  }
  return false;
}

export function missingAgentCliBackend(message: Pick<ChatMessage, "itemType" | "text" | "title" | "details">): AgentBackendMode | null {
  if (message.itemType !== "error") return null;
  const text = [message.title, message.text, message.details].filter(Boolean).join("\n");
  const spawnBackend = backendFromMissingSpawn(text);
  if (spawnBackend) return spawnBackend;
  if (EXPLICIT_CLI_CONFIGURATION_ERROR_PATTERN.test(text)) return null;
  if (hasMissingCliMessage(text, MISSING_CODEX_CLI_PATTERN)) return "codex-cli";
  if (hasMissingCliMessage(text, MISSING_OPENCODE_CLI_PATTERN)) return "opencode";
  if (hasMissingCliMessage(text, MISSING_HERMES_CLI_PATTERN)) return "hermes";
  return null;
}

export function isMissingCodexCliMessage(message: Pick<ChatMessage, "itemType" | "text" | "title" | "details">): boolean {
  return missingAgentCliBackend(message) === "codex-cli";
}

export function agentRecoveryCopy(language: SettingsLanguage, backend: AgentBackendMode): {
  title: string;
  detail: string;
  repair: string;
  settings: string;
  diagnostic: string;
} {
  const label = backend === "codex-cli" ? "Codex" : backend === "opencode" ? "OpenCode" : "Hermes";
  if (language === "en") {
    return {
      title: `${label} is not ready`,
      detail: backend === "codex-cli"
        ? "EchoInk can find Codex bundled with ChatGPT and guide you through connecting it."
        : `EchoInk can install and connect ${label} for you.`,
      repair: "Auto repair",
      settings: "Open settings",
      diagnostic: "View diagnostic"
    };
  }
  return {
    title: `${label} 尚未就绪`,
    detail: backend === "codex-cli"
      ? "EchoInk 可以自动查找 ChatGPT 内置 Codex，并引导你完成连接。"
      : `EchoInk 可以帮你安装并连接 ${label}。`,
    repair: "自动修复",
    settings: "打开设置",
    diagnostic: "查看诊断"
  };
}

export function codexRecoveryCopy(language: SettingsLanguage): ReturnType<typeof agentRecoveryCopy> {
  return agentRecoveryCopy(language, "codex-cli");
}
