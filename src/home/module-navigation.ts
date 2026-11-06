import type CodexForObsidianPlugin from "../main";
import type { AgentDefinition, AgentModuleId } from "../agents/types";
import { getModuleOwner } from "../agents/registry";

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
