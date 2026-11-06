import type { AgentEditorCreationOptions } from "../codex-view/agent-editor-contract";
import type { App } from "obsidian";
import type { MobileStore } from "../../mobile/store";
import type { MobileRuntime } from "../../mobile/runtime";
import type { MobileServices } from "../../mobile/services";
import type { MobileSettings } from "../../mobile/settings";
import type { MobileAgentRegistryService } from "../../mobile/agent-registry-service";
import type { MobileWorkbenchPort } from "../../mobile/workbench-contract";
export type { MobileWorkbenchPort } from "../../mobile/workbench-contract";
import type { AgentModuleId } from "../../agents/types";
import type { MobileSettingsRoute } from "../mobile/settings-pages";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPadShell } from "./shell";
import type { AccountService } from "../../membership/account-service";
import type { MobileRequest, MobileStreamFetch } from "../../mobile/transport";
import type { CompanyService } from "../../company/service";

export interface IPadWorkbenchHost {
  app: App;
  store: MobileStore;
  runtime: MobileRuntime;
  services: MobileServices;
  agents: MobileAgentRegistryService;
  workbench: MobileWorkbenchPort;
  accountService?: AccountService;
  version?: string;
  settings: () => MobileSettings;
  saveSettings: () => Promise<void>;
  modelRequest?: MobileRequest;
  modelFetch?: MobileStreamFetch;
  openSettings?: (category?: string, creation?: AgentEditorCreationOptions) => Promise<void>;
  openNote: (path: string) => Promise<void>;
  openLegacy: (page: MobileSettingsRoute) => Promise<void>;
  openModule: (module: AgentModuleId) => Promise<void>;
  openHome: (resetRoute?: boolean) => Promise<void>;
  openAgent: (route: IPadAgentRoute) => Promise<void>;
  openSearch: () => Promise<void>;
  resumeTask: (taskId: string) => Promise<void>;
  renderMarkdown: (text: string, element: HTMLElement, sourcePath?: string) => void;
  /** Null when the company record is unavailable on this device. */
  company?: () => CompanyService | null;
  /** The project page opens in the central home pane. */
  openProject?: (projectId: string) => Promise<void>;
}

export type IPadRoute = { kind: "home" } | { kind: "agent"; agentId: string }
  | { kind: "task"; taskId: string } | { kind: "agent-form"; agentId?: string; creation?: AgentEditorCreationOptions } | { kind: "project"; projectId: string };

export type IPadAgentRoute = Exclude<IPadRoute, { kind: "home" } | { kind: "project" }>;

export interface IPadPageContext {
  root: HTMLElement;
  host: IPadWorkbenchHost;
  document: Document;
  shell: IPadShell;
  navigate: (route: IPadRoute, replace?: boolean) => Promise<void>;
  error: (error: unknown) => void;
}

export type IPadPageFactory = (context: IPadPageContext) => MobileShellPage;
