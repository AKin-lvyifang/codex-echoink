import type { PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode } from "../types/app-server";

export type AgentBackendKind = "codex-cli" | "opencode";
export type AgentInputModality = "text" | "image" | "pdf";

export interface AgentModelInfo {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  inputModalities: AgentInputModality[];
}

export type AgentProfileMode = "subagent" | "primary" | "all";

export interface AgentProfileInfo {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  mode: AgentProfileMode;
  native?: boolean;
}

export interface AgentSessionOptions {
  title: string;
  model?: {
    providerId: string;
    modelId: string;
  };
  agent?: string;
  permission?: PermissionMode;
  reasoning?: ReasoningEffort;
  serviceTier?: ServiceTierChoice;
  mode?: UiMode;
  writableRoots?: string[];
}

export interface AgentTextPart {
  type: "text";
  text: string;
}

export interface AgentFilePart {
  type: "file";
  path: string;
  filename?: string;
  mime: string;
}

export type AgentPromptPart = AgentTextPart | AgentFilePart;

export interface AgentPromptOptions {
  sessionId: string;
  parts: AgentPromptPart[];
  model?: {
    providerId: string;
    modelId: string;
  };
  agent?: string;
  system?: string;
  tools?: Record<string, boolean>;
}

export interface AgentFileStatus {
  path: string;
  status: string;
  added?: number;
  removed?: number;
}

export interface AgentBackend {
  kind: AgentBackendKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listModels(): Promise<AgentModelInfo[]>;
  listAgents?(): Promise<AgentProfileInfo[]>;
  startSession(options: AgentSessionOptions): Promise<{ sessionId: string; title: string }>;
  sendPrompt(options: AgentPromptOptions): Promise<string>;
  sendPromptAsync?(options: AgentPromptOptions): Promise<void>;
  abort(sessionId: string): Promise<void>;
  fileStatus?(): Promise<AgentFileStatus[]>;
}
