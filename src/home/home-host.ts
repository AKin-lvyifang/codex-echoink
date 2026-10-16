import type { App, EventRef } from "obsidian";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import type { CapabilityAccess } from "../membership/types";
import type { HomeActivityCore } from "./home-activity-core";
import type { EchoInkTodoStore } from "./todo-store";

export interface TodoHost {
  app: App;
  settings: Pick<CodexForObsidianSettings, "settingsLanguage" | "todos" | "todoCategories" | "todoCompletions">;
  registerEvent(event: EventRef): void;
  saveSettings(): Promise<void>;
  getTodoStore(): EchoInkTodoStore;
}
export interface HomeHost extends TodoHost {
  settings: TodoHost["settings"] & { knowledgeBase?: CodexForObsidianSettings["knowledgeBase"] } & Pick<CodexForObsidianSettings, "journalDirectory" | "englishDiary" | "homeModules" | "lifestyle">;
  homeActivity: HomeActivityCore | null;
  settingsKnowledgeBindings?(): import("../knowledge-base/folder-bindings").KnowledgeFolderBindings | null | undefined;
  accountService?: CapabilityAccess | null;
  homeUnavailableReason?: string;
  englishDiary: {
    readonly api?: Pick<import("../english-diary/types").EnglishDiaryApi, "repository">;
    enabled(): boolean;
    setHomeShortcut(choice: "english-diary" | "quick-record"): Promise<void>;
    openToday(): Promise<unknown>;
    openDiary(path: string): Promise<unknown>;
    openLibrary?(expressionId?: string): Promise<unknown>;
  } | null;
  lifestyle: { open(kind: "finance"): Promise<unknown> };
  getKnowledgeSurfaceService(): { getDashboardSnapshot(): Promise<KnowledgeBaseDashboardSnapshot> } | null;
  openEchoInkKnowledgeSettings(): Promise<void>;
  openEchoInkGeneralSettings(): Promise<void>;
  requireAvailableEchoInkSkill(id: string): Promise<unknown>;
  openEchoInkSkillSettings(id: string): Promise<void>;
  activateView(): Promise<void>;
  getCodexView(): {
    startHomeConversation(input: { title: string; message: string; defaultSkillId?: string }): Promise<unknown>;
    createAndStartGuidedSession(input: { title: string; prompt: string; defaultSkillId: string }): Promise<unknown>;
  } | null;
}
