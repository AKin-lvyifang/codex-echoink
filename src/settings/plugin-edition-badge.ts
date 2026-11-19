import { setIcon } from "obsidian";
import type { SettingsLanguage } from "./settings";

/** Shared edition badge from the English diary plugin. */
export function createPluginEditionBadge(parent: HTMLElement, edition: "pro" | "max" | "basic", language: SettingsLanguage): HTMLElement {
  const pro = edition === "pro" || edition === "max";
  const badge = parent.createSpan({
    cls: `codex-resource-preset-badge echoink-plugin-edition-badge${pro ? " is-pro" : ""}`,
    attr: { "data-plugin-edition": edition }
  });
  if (pro) setIcon(badge.createSpan({ cls: "echoink-plugin-edition-icon", attr: { "aria-hidden": "true" } }), "sparkles");
  badge.createSpan({ text: edition === "max" ? "Max" : pro ? "PRO" : language === "en" ? "Basic" : "基础" });
  return badge;
}
