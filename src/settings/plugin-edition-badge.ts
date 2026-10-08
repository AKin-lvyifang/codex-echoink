import { setIcon } from "obsidian";
import type { SettingsLanguage } from "./settings";

/** Shared edition badge from the English diary plugin. */
export function createPluginEditionBadge(parent: HTMLElement, edition: "pro" | "basic", language: SettingsLanguage): HTMLElement {
  const pro = edition === "pro";
  const badge = parent.createSpan({
    cls: `codex-resource-preset-badge echoink-plugin-edition-badge${pro ? " is-pro" : ""}`,
    attr: { "data-plugin-edition": edition }
  });
  if (pro) setIcon(badge.createSpan({ cls: "echoink-plugin-edition-icon", attr: { "aria-hidden": "true" } }), "sparkles");
  badge.createSpan({ text: pro ? "PRO" : language === "en" ? "Basic" : "基础" });
  return badge;
}
