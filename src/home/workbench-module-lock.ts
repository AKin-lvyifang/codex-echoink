import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentModuleId } from "../agents/types";
import { hasProPluginAccess } from "../membership/access";
import { createOriginButton } from "../settings/origin-controls";
import { createPluginEditionBadge } from "../settings/plugin-edition-badge";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { WORKBENCH_MODULES } from "./module-navigation";

export type ProWorkbenchModuleId = "finance" | "english-diary" | "pdf-reading";
export function isProWorkbenchModule(id: AgentModuleId): id is ProWorkbenchModuleId {
  return id === "finance" || id === "english-diary" || id === "pdf-reading";
}
export function workbenchProModuleEnabled(plugin: CodexForObsidianPlugin, id: ProWorkbenchModuleId): boolean {
  return (id === "finance" ? plugin.settings.lifestyle.finance.enabled : id === "english-diary" ? plugin.settings.englishDiary.enabled : plugin.settings.pdfReading.enabled) !== false;
}
export function workbenchHasPro(plugin: CodexForObsidianPlugin): boolean {
  return !!plugin.accountService && hasProPluginAccess(plugin.accountService);
}

/** A static module landing page: no service initialization, data read, or task action. */
export function renderWorkbenchModuleLock(parent: HTMLElement, plugin: CodexForObsidianPlugin, id: ProWorkbenchModuleId, onBack: () => void): HTMLElement {
  const en = plugin.settings.settingsLanguage === "en";
  const module = WORKBENCH_MODULES.find(module => module.id === id)!;
  const page = parent.createDiv({ cls: "wb-page wb-module-lock", attr: { "data-wb": "module-lock", "data-locked-module": id } });
  const header = page.createDiv({ cls: "wb-module-lock-header" });
  const back = createOriginButton(header, { cls: "wb-button is-icon", attr: { "aria-label": en ? "Back to workbench" : "返回工作台", "data-wb-focus": "module-lock-back" } });
  setIcon(back, "arrow-left"); applyAmicroButton(back, { variant: "icon" }); back.onclick = onBack;
  const title = header.createDiv({ cls: "wb-module-lock-title" });
  title.createEl("h1", { text: en ? module.en : module.zh });
  createPluginEditionBadge(title, "pro", plugin.settings.settingsLanguage);
  const descriptions = {
    finance: en ? "Finance is a PRO module for recording expenses, importing bills, budgeting and analysis." : "财务是 PRO 模块，可记账、导入账单、管理预算与分析收支。",
    "english-diary": en ? "English diary is a PRO module for turning journals into English drafts and collecting expressions." : "英文日记是 PRO 模块，可将日记整理成英文稿，并积累表达。",
    "pdf-reading": en ? "PDF reading is a PRO module for extracting originals, translating, close reading and summaries." : "PDF 精读是 PRO 模块，可提取原文、翻译、精读与生成摘要。"
  };
  page.createEl("p", { cls: "wb-secondary", text: descriptions[id] });
  const actions = page.createDiv({ cls: "wb-module-lock-actions" });
  for (const [key, text, variant] of [["login", en ? "Sign in" : "登录", "tertiary"], ["benefits", en ? "View PRO benefits" : "查看 PRO 权益", "primary"]] as const) {
    const button = createOriginButton(actions, { text, cls: `wb-button is-${variant}`, attr: { "data-wb-focus": `module-lock-${key}` } });
    applyAmicroButton(button, { variant });
    button.onclick = () => { void plugin.openEchoInkAccountSettings(key).catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
  }
  return page;
}
