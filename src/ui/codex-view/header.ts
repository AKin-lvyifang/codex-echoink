import { setIcon } from "obsidian";
import type { SettingsLanguage } from "../../settings/settings";
import { renderSettingsGearIcon } from "../codex-icon";
import type { AgentIdentityView } from "./message-list";
import { conversationUiText } from "./ui-i18n";

export interface CodexHeaderCallbacks {
  onOpenWorkspaceResources: () => void;
  onOpenSettings: () => void;
  /** Present when the view can migrate back to the sidebar (quick chat popout). */
  onReturnToSidebar?: () => void;
}

const DEFAULT_AGENT_IDENTITY: AgentIdentityView = Object.freeze({
  displayName: "EchoInk",
  avatarUrl: null
});

export function renderCodexHeader(
  rootEl: HTMLElement,
  callbacks: CodexHeaderCallbacks,
  identity: Readonly<AgentIdentityView> = DEFAULT_AGENT_IDENTITY,
  language: SettingsLanguage = "zh-CN"
): void {
  const header = rootEl.createDiv({ cls: "codex-header" });
  const title = header.createDiv({ cls: "codex-title" });
  const icon = title.createSpan({ cls: "codex-title-icon codex-title-icon-codex", attr: { "aria-hidden": "true" } });
  title.createSpan({ cls: "codex-title-text" });
  updateCodexHeaderIdentity(header, identity);

  const headerActions = header.createDiv({ cls: "codex-header-actions" });
  const returnButton = headerActions.createEl("button", {
    cls: "codex-icon-button codex-quick-return-button",
    attr: { type: "button" }
  });
  applyCodexHeaderCopy(returnButton, language, "return");
  setIcon(returnButton, "panel-right");
  if (callbacks.onReturnToSidebar) {
    returnButton.onclick = callbacks.onReturnToSidebar;
  } else {
    returnButton.remove();
  }
  const resourceButton = headerActions.createEl("button", {
    cls: "codex-icon-button codex-resource-button",
    attr: { type: "button" }
  });
  applyCodexHeaderCopy(resourceButton, language, "resource");
  setIcon(resourceButton, "blocks");
  resourceButton.onclick = callbacks.onOpenWorkspaceResources;

  const settingsButton = headerActions.createEl("button", {
    cls: "codex-icon-button codex-settings-button",
    attr: {
      type: "button",
      "data-echoink-onboarding-anchor": "settings"
    }
  });
  applyCodexHeaderCopy(settingsButton, language, "settings");
  renderSettingsGearIcon(settingsButton);
  settingsButton.onclick = callbacks.onOpenSettings;
}

export function refreshCodexHeaderCopy(rootEl: HTMLElement, language: SettingsLanguage): void {
  const resourceButton = rootEl.querySelector<HTMLButtonElement>(".codex-resource-button");
  if (resourceButton) applyCodexHeaderCopy(resourceButton, language, "resource");
  const settingsButton = rootEl.querySelector<HTMLButtonElement>(".codex-settings-button");
  if (settingsButton) applyCodexHeaderCopy(settingsButton, language, "settings");
  const returnButton = rootEl.querySelector<HTMLButtonElement>(".codex-quick-return-button");
  if (returnButton) applyCodexHeaderCopy(returnButton, language, "return");
}

function applyCodexHeaderCopy(
  button: HTMLButtonElement,
  language: SettingsLanguage,
  kind: "resource" | "settings" | "return"
): void {
  const label = kind === "resource"
    ? conversationUiText(language, "插件 MCP Skills 管理", "Manage plugins, MCP, and Skills")
    : kind === "return"
      ? conversationUiText(language, "回到侧边栏", "Return to sidebar")
      : conversationUiText(language, "打开插件设置", "Open plugin settings");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

/**
 * 只更新聊天栏标题中的身份展示，不重建 Composer、会话标签或滚动区域。
 * 名称和头像来自 CognitiveSystem 的同步缓存；空值始终回退 EchoInk + bot。
 */
export function updateCodexHeaderIdentity(
  rootEl: HTMLElement,
  identity: Readonly<AgentIdentityView> = DEFAULT_AGENT_IDENTITY
): void {
  const icon = rootEl.querySelector<HTMLElement>(".codex-title-icon-codex");
  const label = rootEl.querySelector<HTMLElement>(".codex-title-text");
  if (!icon || !label) return;

  const displayName = identity.displayName.trim() || DEFAULT_AGENT_IDENTITY.displayName;
  const avatarUrl = identity.avatarUrl?.trim() || null;
  label.textContent = displayName;
  icon.empty();
  icon.removeClass("has-image");
  if (!avatarUrl) {
    setIcon(icon, "bot");
    return;
  }
  icon.addClass("has-image");
  icon.createEl("img", {
    cls: "codex-title-avatar",
    attr: {
      src: avatarUrl,
      alt: "",
      draggable: "false",
      decoding: "async"
    }
  });
}
