export type EchoInkResourceKind = "skill" | "mcp-server" | "tool-bundle";
export type EchoInkResourceSource = "echoink-local" | "codex-import" | "hermes-import" | "opencode-import" | "manual";
export type EchoInkResourceScope = "chat" | "knowledge" | "editor-actions";
export type EchoInkResourceBridgeMode = "prompt-only" | "native-mcp" | "structured-tools" | "plugin-tool";
export type EchoInkMcpBrokerApprovalMode = "ask" | "deny";
export type EchoInkMcpToolCallStatus = "approved" | "denied" | "completed" | "failed";

export interface EchoInkMcpStdioConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface EchoInkMcpHttpConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type EchoInkMcpConnectionConfig = EchoInkMcpStdioConfig | EchoInkMcpHttpConfig;

export type EchoInkMcpConnectionRecord = EchoInkMcpConnectionConfig & {
  verifiedAt?: number;
  lastError?: string;
};

export type EchoInkMcpConnectionRecords = Record<string, EchoInkMcpConnectionRecord>;

export interface EchoInkMcpToolCallLogEntry {
  id: string;
  createdAt: number;
  resourceId: string;
  resourceName: string;
  scope: EchoInkResourceScope;
  backend: string;
  toolName: string;
  status: EchoInkMcpToolCallStatus;
  message: string;
}

export interface EchoInkMcpBrokerSettings {
  approvalMode: EchoInkMcpBrokerApprovalMode;
  callLog: EchoInkMcpToolCallLogEntry[];
}

export interface EchoInkCallableMcpTool {
  name: string;
  resourceId: string;
  resourceName: string;
  toolName: string;
  description: string;
  inputSchema?: unknown;
}

export interface EchoInkCallableMcpToolCatalog {
  tools: EchoInkCallableMcpTool[];
  warnings: string[];
}

export interface EchoInkResource {
  id: string;
  kind: EchoInkResourceKind;
  source: EchoInkResourceSource;
  name: string;
  description: string;
  enabled: boolean;
  scopes: EchoInkResourceScope[];
  bridgeMode: EchoInkResourceBridgeMode;
  configPath?: string;
  contentPath?: string;
  metadata?: Record<string, unknown>;
}

export type EchoInkSkillResource = EchoInkResource & { kind: "skill" };

export interface EchoInkResourceSettings {
  catalog: EchoInkResource[];
  enabledByScope: Record<EchoInkResourceScope, Record<string, boolean>>;
  importedFrom: Partial<Record<EchoInkResourceSource, number>>;
  mcpBroker: EchoInkMcpBrokerSettings;
  mcpConnections: EchoInkMcpConnectionRecords;
  lastScannedAt: number;
  lastError: string;
}

export const ECHOINK_RESOURCE_SCOPES: EchoInkResourceScope[] = ["chat", "knowledge", "editor-actions"];
