import type { ChatMessage, SettingsLanguage } from "../settings/settings";
import type { AgentBackendMode } from "../settings/settings";

const MISSING_CODEX_CLI_PATTERN = /(?:找不到|未找到|缺少)\s*codex\s*cli|codex\s*cli\s*(?:not found|missing)|(?:not found|missing)\s+codex\s+cli|spawn\s+[^\s]*codex[^\n]*enoent|enoent[^\n]*codex/i;
const MISSING_OPENCODE_CLI_PATTERN = /(?:找不到|未找到|缺少)\s*opencode\s*(?:cli)?|opencode\s*cli\s*(?:not found|missing)|(?:not found|missing)\s+opencode\s+cli|spawn\s+[^\s]*opencode[^\n]*enoent|enoent[^\n]*opencode/i;
const MISSING_HERMES_CLI_PATTERN = /(?:找不到|未找到|缺少)\s*hermes\s*(?:cli)?|hermes\s*cli\s*(?:not found|missing)|(?:not found|missing)\s+hermes\s+cli|spawn\s+[^\s]*hermes[^\n]*enoent|enoent[^\n]*hermes/i;

export function missingAgentCliBackend(message: Pick<ChatMessage, "itemType" | "text" | "title" | "details">): AgentBackendMode | null {
  if (message.itemType !== "error") return null;
  const text = [message.title, message.text, message.details].filter(Boolean).join("\n");
  if (MISSING_CODEX_CLI_PATTERN.test(text)) return "codex-cli";
  if (MISSING_OPENCODE_CLI_PATTERN.test(text)) return "opencode";
  if (MISSING_HERMES_CLI_PATTERN.test(text)) return "hermes";
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
