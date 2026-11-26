import type CodexForObsidianPlugin from "../main";
import type { AgentDefinition, AgentModuleId } from "../agents/types";
import { getModuleOwner } from "../agents/registry";
import { setIcon } from "obsidian";
import { resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";

export const WORKBENCH_MODULES: readonly { id: AgentModuleId; icon: string; zh: string; en: string }[] = [
  { id: "journal", icon: "book-open", zh: "日记", en: "Journal" },
  { id: "todos", icon: "list-todo", zh: "待办", en: "To-dos" },
  { id: "finance", icon: "wallet", zh: "财务", en: "Finance" },
  { id: "knowledge-base", icon: "library", zh: "知识库", en: "Knowledge" },
  { id: "english-diary", icon: "languages", zh: "英文日记", en: "English diary" },
  { id: "pdf-reading", icon: "file-text", zh: "PDF 精读", en: "PDF reading" }
];

/** Always read live assignments; unassigned modules have no fallback. */
export function workbenchModuleOwner(plugin: CodexForObsidianPlugin, moduleId: AgentModuleId): AgentDefinition | null {
  return getModuleOwner(plugin.settings.agentRegistry, moduleId);
}

export async function prefillWorkbenchModule(plugin: CodexForObsidianPlugin, moduleId: AgentModuleId, text: string): Promise<boolean> {
  const owner = workbenchModuleOwner(plugin, moduleId);
  if (!owner) { plugin.openModuleOwnerPicker(moduleId, () => plugin.startModulePromptTask(moduleId, text)); return false; }
  return plugin.openAgentTaskList(owner.id, text);
}

/** 标题栏次按钮：具体动作文字 + 负责人小头像；无负责人时只显示动作，点击走“指定负责人”。 */
export function renderModuleOwnerAction(button: HTMLElement, owner: Pick<AgentDefinition, "id" | "name" | "avatar"> | null, label: string): void {
  const url = owner?.avatar ? resolveAgentAvatarUrl(owner.avatar) : null;
  const key = JSON.stringify([label, owner?.id ?? "", owner?.name ?? "", url ? `${url.length}:${url.slice(-48)}` : ""]);
  if (button.dataset.moduleOwnerAction === key) return;
  button.dataset.moduleOwnerAction = key; button.empty(); button.addClass("echoink-module-owner-action");
  if (owner) {
    const avatar = button.createSpan({ cls: "echoink-module-owner-avatar", attr: { "aria-hidden": "true" } });
    if (url) avatar.createEl("img", { attr: { src: url, alt: "", draggable: "false" } }); else setIcon(avatar, "bot");
  }
  button.createSpan({ text: label });
  if (owner) button.setAttribute("aria-label", `${label} · ${owner.name}`); else button.removeAttribute("aria-label");
}

/** New module pages replace only their own legacy navigation targets. */
export async function openWorkbenchModule(plugin: CodexForObsidianPlugin, moduleId: AgentModuleId): Promise<void> {
  switch (moduleId) {
    case "journal": await plugin.activateJournalView(); break;
    case "todos": await plugin.activateTodoView(); break;
    case "finance": await plugin.lifestyle.open("finance"); break;
    case "knowledge-base": await plugin.activateKnowledgeView(); break;
    case "english-diary": await plugin.activateEnglishDiaryPage(); break;
    case "pdf-reading":
      await plugin.activatePdfReadingPage();
      break;
  }
}
