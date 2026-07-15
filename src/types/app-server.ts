export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";
export type UiMode = "agent" | "plan";
export type ServiceTierChoice = "standard" | "fast" | "flex";

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{ effort: ReasoningEffort } | ReasoningEffort | string>;
  defaultReasoningEffort?: ReasoningEffort;
  inputModalities?: string[];
}

export interface CodexSkill {
  name: string;
  description: string;
  path: string;
  scope?: string;
  enabled?: boolean;
}

export interface CodexPluginInfo {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  marketplace?: string;
  category?: string;
  installed?: boolean;
  enabled?: boolean;
}

export interface McpServerStatus {
  name: string;
  tools?: Record<string, unknown>;
  resources?: unknown[];
  resourceTemplates?: unknown[];
  authStatus?: string;
}

export interface WorkspaceResourceSnapshot {
  plugins: CodexPluginInfo[];
  skills: CodexSkill[];
  mcpServers: McpServerStatus[];
  errors: {
    plugins?: string;
    skills?: string;
    mcp?: string;
    config?: string;
  };
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

export type UserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "localImage"; path: string }
  | { type: "mention"; name: string; path: string }
  | { type: "skill"; name: string; path: string };

export interface SandboxPolicy {
  type: "dangerFullAccess" | "readOnly" | "workspaceWrite";
  access?: { type: "fullAccess" };
  readOnlyAccess?: { type: "fullAccess" };
  networkAccess?: boolean;
  writableRoots?: string[];
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export interface CodexStatusSnapshot {
  connected: boolean;
  codexHome?: string;
  platform?: string;
  accountLabel: string;
  loggedIn: boolean;
  accountReadError?: string | null;
  configModel?: string | null;
  profile?: string | null;
  models: CodexModel[];
  skills: CodexSkill[];
  mcpServers: McpServerStatus[];
  rateLimits?: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null;
  errors: string[];
}

export interface TokenUsage {
  total?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  last?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  modelContextWindow?: number | null;
}

export type ProcessFileKind = "vault" | "external" | "unknown";
export type ProcessEventKind = "reasoning" | "plan" | "search" | "view" | "edit" | "run" | "tool" | "command" | "other";

export interface ProcessFileRef {
  name: string;
  path: string;
  displayPath: string;
  kind: ProcessFileKind;
  openable: boolean;
  absolutePath?: string;
}

export interface ProcessEventSummary {
  title: string;
  detail: string;
  files: ProcessFileRef[];
  defaultOpen: boolean;
  kind: ProcessEventKind;
}

export interface CodexNotification {
  method: string;
  params: unknown;
}

export interface CodexServerRequest {
  method: string;
  id: number | string;
  params: unknown;
}
