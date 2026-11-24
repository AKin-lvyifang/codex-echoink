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
import type { IPhoneShell } from "./shell";
import type { AccountService } from "../../membership/account-service";
import type { MobileRequest, MobileStreamFetch } from "../../mobile/transport";
import type { CompanyService } from "../../company/service";
import type { SyncOverviewService } from "../../sync/overview-service";
import type { SyncRequestService } from "../../sync/requests";
import type { CloudSyncController } from "../../sync/cloud/controller";

export interface IPhoneWorkbenchHost {
  app: App;
  releaseUpdate?: import("../../settings/release-update").ReleaseUpdateController;
  store: MobileStore;
  reloadTaskFile?: () => Promise<void>;
  runtime: MobileRuntime;
  services: MobileServices;
  agents: MobileAgentRegistryService;
  workbench: MobileWorkbenchPort;
  accountService?: AccountService;
  reportLogin?: import("../../run-reports/login").RunReportLogin;
  version?: string;
  modelRequest?: MobileRequest;
  modelFetch?: MobileStreamFetch;
  settings: () => MobileSettings;
  saveSettings: () => Promise<void>;
  openNote: (path: string) => Promise<void>;
  openLegacy: (page: MobileSettingsRoute) => Promise<void>;
  openModule: (module: AgentModuleId) => Promise<void>;
  renderMarkdown: (text: string, element: HTMLElement, sourcePath?: string) => void;
  /** Null when the company record is unavailable on this device. */
  company?: () => CompanyService | null;
  /** Other devices' sync folders, read-only; null when sync is off. */
  syncOverview?: () => SyncOverviewService | null;
  syncRequests?: () => SyncRequestService | null;
  /** EchoInk cloud sync; null when it is not available on this device. */
  cloudSync?: () => CloudSyncController | null;
}

export type IPhoneRoute = { kind: "home" } | { kind: "agent"; agentId: string }
  | { kind: "task"; taskId: string } | { kind: "agent-form"; agentId?: string; creation?: AgentEditorCreationOptions } | { kind: "project"; projectId: string; deviceId?: string } | { kind: "remote-conversation"; deviceId: string; conversationId: string };

export interface IPhonePageContext {
  host: IPhoneWorkbenchHost;
  document: Document;
  shell: IPhoneShell;
  navigate: (route: IPhoneRoute, replace?: boolean) => Promise<void>;
  error: (error: unknown) => void;
}

export type IPhonePageFactory = (context: IPhonePageContext) => MobileShellPage;
