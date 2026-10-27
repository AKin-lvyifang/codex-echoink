import { TFolder, setIcon, Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentModuleId } from "../agents/types";
import { readNativeJournalSettings } from "./native-journal";
import { validWorkbenchBindingRoots } from "../knowledge-base/link-health";
import { WORKBENCH_MODULES } from "./module-navigation";
import { createOriginButton } from "../settings/origin-controls";
import { applyAmicroButton } from "../settings/amicro-buttons";

/** Navigation remains discoverable; only real configuration authorizes module use. */
export function workbenchModuleSetupReason(plugin: CodexForObsidianPlugin, id: AgentModuleId): string | null {
  const en = plugin.settings.settingsLanguage === "en";
  const t = (zh: string, english: string) => en ? english : zh;
  const bindings = plugin.settings.knowledgeBase?.folderBindings;
  if (id === "journal") {
    if (bindings && !bindings.roles.journal.enabled) return t("日记尚未开启", "Journal is turned off");
    try {
      const journal = readNativeJournalSettings(plugin.app, plugin.settings.journalDirectory, bindings);
      if (!journal.available || journal.folder && !(plugin.app.vault.getAbstractFileByPath(journal.folder) instanceof TFolder)) return t("还没有日记文件夹", "No journal folder is available");
    } catch { return t("日记文件夹配置无效", "The journal folder configuration is invalid"); }
  }
  if (id === "knowledge-base" && (!bindings || !(["raw", "wiki", "projects", "inbox"] as const).some(role => validWorkbenchBindingRoots(plugin.app, bindings, role).length))) return t("还没有绑定知识库文件夹", "No knowledge folders are connected");
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
