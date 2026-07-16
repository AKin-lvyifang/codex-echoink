import type { AgentBackendKind, AgentConnectionStatus, AgentModelInfo, AgentProfileInfo, AgentSessionOptions, AgentTaskInput, AgentTaskResult } from "./types";
import type { AgentEventSink } from "./events";
import type { EchoInkResource, EchoInkResourceScope } from "../resources/types";

export interface EchoInkToolBridge {
  mode: "disabled" | "native-mcp" | "structured-tools" | "echoink-tool-loop";
  resourceIds: string[];
  ready: boolean;
  note: string;
}

export interface AgentToolBridgeRuntime {
  enabled: boolean;
  scope: EchoInkResourceScope;
  maxToolCalls: number;
  prompt: string;
  toolResourceIds?: Record<string, string>;
  callTool(input: {
    toolCallId?: string;
    tool: string;
    arguments?: Record<string, unknown>;
    scope: EchoInkResourceScope;
    backend: AgentBackendKind;
    emit?: AgentEventSink;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface PreparedAgentResources {
  promptPrefix: string;
  enabledResources: EchoInkResource[];
  warnings: string[];
  mcpConfig: Record<string, unknown> | null;
  toolBridge: EchoInkToolBridge | null;
}

export interface AgentTaskRuntime {
  kind: AgentBackendKind;
  connect(): Promise<AgentConnectionStatus>;
  disconnect?(): Promise<void>;
  listModels(): Promise<AgentModelInfo[]>;
  listAgents?(): Promise<AgentProfileInfo[]>;
  hasNativeSession?(sessionId: string): Promise<boolean>;
  deleteNativeSession?(sessionId: string): Promise<boolean>;
  runTask(input: AgentTaskInput): Promise<AgentTaskResult>;
  abort(runId: string): Promise<void>;
}

export interface AgentEventTaskRuntime extends AgentTaskRuntime {
  runTaskEvents(input: AgentTaskInput, emit: AgentEventSink): Promise<AgentTaskResult>;
}

export interface AgentRichStreamRuntime extends AgentTaskRuntime {
  runTaskStream(input: AgentTaskInput, emit: AgentEventSink): Promise<AgentTaskResult>;
}

export interface AgentChatRuntime extends AgentTaskRuntime {
  startChatSession(input: AgentSessionOptions): Promise<{ sessionId: string; title: string }>;
}
