import type { AgentDefinition, AgentModuleId } from "../agents/types";
import type { App, EventRef } from "obsidian";
import type { CodexForObsidianSettings } from "../settings/settings";
import type { CapabilityAccess } from "../membership/types";
import type { LifestyleStoreCore } from "./store-core";
import type { LifestyleFinanceService } from "./finance-service";
import type { LifestyleKind } from "./settings";

/** The existing finance workspace's host contract, shared by desktop and mobile. */
export interface LifestylePluginHost {
  app: App;
  settings: Pick<CodexForObsidianSettings, "lifestyle" | "homeModules" | "apiProviders" | "activeApiProviderId" | "defaultModel"> & { diaryOrganizerEnabled?: boolean };
  accountService?: CapabilityAccess | null;
  saveSettings(refresh?: boolean): Promise<void>;
  registerEvent(event: EventRef): void;
  notifyHomeSurfacesChanged(): void;
  getSkillRuntimeCoordinator(): { resolveById(id: string): Promise<unknown>; recordUse(id: string): Promise<void> };
  requireAvailableEchoInkSkill(id: string): Promise<unknown>;
  readEchoInkBuiltinSkill(id: string): Promise<{ fileStatus: string; content: string }>;
  generateLifestyleText(system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<string>;
  openLifestyleSettings(kind: LifestyleKind): Promise<void>;
  activateHomeView?(options?: { keepRightSidebar?: boolean }): Promise<void>;
  getWorkbenchModuleOwner?(moduleId: AgentModuleId): AgentDefinition;
  prefillWorkbenchModule?(moduleId: AgentModuleId, text: string): Promise<boolean>;
  saveFinanceCsv?(name: string, content: string): Promise<string>;
}
export interface LifestyleViewPort { contentEl?: HTMLElement; render(): void; releaseResources(): void }
export interface LifestyleHost {
  plugin: LifestylePluginHost;
  store: LifestyleStoreCore;
  finance: LifestyleFinanceService;
  refresh(): void;
  registerView(view: LifestyleViewPort): void;
  unregisterView(view: LifestyleViewPort): void;
  viewportRoot?(): HTMLElement | undefined;
}
