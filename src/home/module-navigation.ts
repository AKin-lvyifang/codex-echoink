import type CodexForObsidianPlugin from "../main";
import type { AgentModuleId } from "../agents/types";
import { GENERAL_ASSISTANT_ID } from "../agents/types";

export const WORKBENCH_MODULES: readonly { id: AgentModuleId; icon: string; zh: string; en: string }[] = [
  { id: "journal", icon: "book-open", zh: "日记", en: "Journal" },
  { id: "todos", icon: "list-todo", zh: "待办", en: "To-dos" },
  { id: "finance", icon: "wallet", zh: "财务", en: "Finance" },
  { id: "knowledge-base", icon: "library", zh: "知识库", en: "Knowledge" },
  { id: "english-diary", icon: "languages", zh: "英文日记", en: "English diary" },
  { id: "pdf-reading", icon: "file-text", zh: "PDF 精读", en: "PDF reading" }
];

/** P5 routes to the existing working surfaces until the module pages ship. */
export async function openWorkbenchModule(plugin: CodexForObsidianPlugin, moduleId: AgentModuleId): Promise<void> {
  switch (moduleId) {
    case "journal": await plugin.activateLegacyHomeView("calendar"); break;
    case "todos": await plugin.activateLegacyHomeView("todos"); break;
    case "finance": await plugin.lifestyle.open("finance"); break;
    case "knowledge-base": await plugin.openEchoInkKnowledgeSettings(); break;
    case "english-diary": await plugin.englishDiary?.openToday(); break;
    case "pdf-reading":
      await plugin.openAgentTaskList(plugin.settings.agentRegistry.moduleOwners[moduleId] ?? GENERAL_ASSISTANT_ID);
      break;
  }
}
