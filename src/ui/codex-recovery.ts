import type { ChatMessage, SettingsLanguage } from "../settings/settings";

const MISSING_CODEX_CLI_PATTERN = /(?:找不到|未找到|缺少)\s*codex\s*cli|codex\s*cli\s*(?:not found|missing)|(?:not found|missing)\s+codex\s+cli|spawn\s+[^\s]*codex[^\n]*enoent|enoent[^\n]*codex/i;

export function isMissingCodexCliMessage(message: Pick<ChatMessage, "itemType" | "text" | "title" | "details">): boolean {
  if (message.itemType !== "error") return false;
  return MISSING_CODEX_CLI_PATTERN.test([message.title, message.text, message.details].filter(Boolean).join("\n"));
}

export function codexRecoveryCopy(language: SettingsLanguage): {
  title: string;
  detail: string;
  repair: string;
  settings: string;
  diagnostic: string;
} {
  if (language === "en") {
    return {
      title: "Codex is not ready",
      detail: "EchoInk can find Codex bundled with ChatGPT and guide you through connecting it.",
      repair: "Auto repair",
      settings: "Open settings",
      diagnostic: "View diagnostic"
    };
  }
  return {
    title: "Codex 尚未就绪",
    detail: "EchoInk 可以自动查找 ChatGPT 内置 Codex，并引导你完成连接。",
    repair: "自动修复",
    settings: "打开设置",
    diagnostic: "查看诊断"
  };
}
