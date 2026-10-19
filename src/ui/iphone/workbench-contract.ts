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
import type { IPhoneShell } from "./shell";
import type { AccountService } from "../../membership/account-service";

export interface IPhoneWorkbenchHost {
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
  openNote: (path: string) => Promise<void>;
  openLegacy: (page: MobileSettingsRoute) => Promise<void>;
  openModule: (module: AgentModuleId) => Promise<void>;
  renderMarkdown: (text: string, element: HTMLElement, sourcePath?: string) => void;
}

export type IPhoneRoute = { kind: "home" } | { kind: "agent"; agentId: string }
  | { kind: "task"; taskId: string } | { kind: "agent-form"; agentId?: string };

export interface IPhonePageContext {
  host: IPhoneWorkbenchHost;
  document: Document;
  shell: IPhoneShell;
  navigate: (route: IPhoneRoute, replace?: boolean) => Promise<void>;
  error: (error: unknown) => void;
}

export type IPhonePageFactory = (context: IPhonePageContext) => MobileShellPage;
