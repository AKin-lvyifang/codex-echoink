import { setIcon, Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentModuleId } from "../agents/types";
import { WORKBENCH_MODULES } from "./module-navigation";
import { createOriginButton } from "../settings/origin-controls";
import { applyAmicroButton } from "../settings/amicro-buttons";

/** Navigation remains discoverable; only real configuration authorizes module use. */
export function workbenchModuleSetupReason(plugin: CodexForObsidianPlugin, id: AgentModuleId): string | null {
  const en = plugin.settings.settingsLanguage === "en";
  const t = (zh: string, english: string) => en ? english : zh;
  if (id === "finance" && plugin.settings.lifestyle.finance.enabled === false) return t("财务尚未开启", "Finance is turned off");
  if (id === "english-diary" && plugin.settings.englishDiary.enabled === false) return t("英文日记尚未开启", "English diary is turned off");
  if (id === "pdf-reading" && plugin.settings.pdfReading.enabled === false) return t("PDF 精读尚未开启", "PDF reading is turned off");
  return null;
}

export function renderWorkbenchModuleSetup(parent: HTMLElement, plugin: CodexForObsidianPlugin, id: AgentModuleId, reason: string, onBack: () => void): HTMLElement {
  const en = plugin.settings.settingsLanguage === "en", module = WORKBENCH_MODULES.find(item => item.id === id)!;
  const page = parent.createDiv({ cls: "wb-page wb-module-setup", attr: { "data-wb": "module-setup", "data-setup-module": id } });
  const header = page.createDiv({ cls: "wb-module-setup-header" });
  const back = createOriginButton(header, { cls: "wb-button is-icon", attr: { "aria-label": en ? "Back to workbench" : "返回工作台", "data-wb-focus": "module-setup-back" } });
  setIcon(back, "arrow-left"); applyAmicroButton(back, { variant: "icon" }); back.onclick = onBack;
  header.createEl("h1", { text: en ? module.en : module.zh });
  const settings = createOriginButton(header, { text: en ? "Go to settings" : "去设置", cls: "wb-button is-primary", attr: { "data-wb-focus": "module-setup-settings" } });
  applyAmicroButton(settings, { variant: "primary" });
  settings.onclick = () => { void plugin.openWorkbenchModuleSettings(id).catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
  page.createEl("p", { cls: "wb-secondary", text: reason });
  return page;
}
