import type {
  EchoInkMcpBrokerSettings,
  EchoInkMcpConnectionConfig,
  EchoInkMcpConnectionRecords,
  EchoInkMcpToolCallLogEntry,
  EchoInkResource,
  EchoInkResourceScope
} from "./types";
import { resolveMcpConnectionConfig } from "./mcp-connections";
import { swallowError } from "../core/error-handling";
import { JsonRpcStdioTransport, type JsonRpcMessage, type JsonRpcStdioLaunch } from "../core/json-rpc-stdio-transport";

export interface EchoInkMcpBrokerInvocation {
  resource: EchoInkResource;
  scope: EchoInkResourceScope;
  backend: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface EchoInkMcpBrokerApprovalRequest {
  resource: EchoInkResource;
  scope: EchoInkResourceScope;
  backend: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface EchoInkMcpBrokerTransport {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify?(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export interface EchoInkMcpBrokerOptions {
  settings: EchoInkMcpBrokerSettings;
  connections?: EchoInkMcpConnectionRecords;
  approval?: (request: EchoInkMcpBrokerApprovalRequest) => Promise<boolean>;
  transportFactory?: (config: EchoInkMcpConnectionConfig) => Promise<EchoInkMcpBrokerTransport>;
}

export interface EchoInkMcpBrokerResult {
  content: unknown;
}

export interface EchoInkMcpToolListResult {
  tools: unknown[];
}

export function defaultMcpBrokerSettings(): EchoInkMcpBrokerSettings {
  return { approvalMode: "ask", callLog: [] };
}

export function normalizeMcpBrokerSettings(value: any): EchoInkMcpBrokerSettings {
  return {
    approvalMode: value?.approvalMode === "deny" ? "deny" : "ask",
    callLog: Array.isArray(value?.callLog)
      ? value.callLog.map(normalizeMcpToolCallLogEntry).filter((item: EchoInkMcpToolCallLogEntry | null): item is EchoInkMcpToolCallLogEntry => Boolean(item)).slice(-100)
      : []
  };
}

export function mcpBrokerConnectionConfig(resource: EchoInkResource): EchoInkMcpConnectionConfig | null {
  return resolveMcpConnectionConfig(resource, { mcpConnections: {} } as any);
}

export function isMcpBrokerConnectable(resource: EchoInkResource, connections?: EchoInkMcpConnectionRecords): boolean {
  return Boolean(resolveMcpConnectionConfig(resource, { mcpConnections: connections ?? {} } as any));
}

export function mcpBrokerResourceStatus(resource: EchoInkResource, connections?: EchoInkMcpConnectionRecords): "connectable" | "imported-only" | "not-mcp" {
  if (resource.kind !== "mcp-server") return "not-mcp";
  return isMcpBrokerConnectable(resource, connections) ? "connectable" : "imported-only";
}

export class EchoInkMcpBroker {
  constructor(private readonly options: EchoInkMcpBrokerOptions) {}

  async listTools(resource: EchoInkResource, timeoutMs = 30000): Promise<EchoInkMcpToolListResult> {
    const config = resolveMcpConnectionConfig(resource, { mcpConnections: this.options.connections ?? {} } as any);
    if (!config) throw new Error("MCP 资源没有 EchoInk broker 连接配置。");
    const transport = await (this.options.transportFactory ?? createDefaultMcpTransport)(config);
    try {
      await initializeMcpClient(transport, timeoutMs);
      const result = await transport.request("tools/list", {}, timeoutMs);
      const tools = Array.isArray((result as any)?.tools) ? (result as any).tools : [];
      return { tools };
    } finally {
      await transport.close().catch(swallowError("close MCP broker transport after listTools"));
    }
  }

  async callTool(invocation: EchoInkMcpBrokerInvocation): Promise<EchoInkMcpBrokerResult> {
    const config = resolveMcpConnectionConfig(invocation.resource, { mcpConnections: this.options.connections ?? {} } as any);
    if (!config) {
      this.record(invocation, "failed", "MCP 资源没有 EchoInk broker 连接配置。");
      throw new Error("MCP 资源没有 EchoInk broker 连接配置。");
    }
    if (this.options.settings.approvalMode === "deny") {
      this.record(invocation, "denied", "MCP broker 审批模式为拒绝。");
      throw new Error("MCP broker 审批模式为拒绝。");
    }
    const approved = this.options.approval ? await this.options.approval(invocation) : false;
    if (!approved) {
      this.record(invocation, "denied", "用户未批准 MCP 工具调用。");
      throw new Error("用户未批准 MCP 工具调用。");
    }
    this.record(invocation, "approved", "MCP 工具调用已批准。");
    const transport = await (this.options.transportFactory ?? createDefaultMcpTransport)(config);
    try {
      await initializeMcpClient(transport, invocation.timeoutMs);
      const content = await transport.request("tools/call", {
        name: invocation.toolName,
        arguments: invocation.arguments ?? {}
      }, invocation.timeoutMs);
      this.record(invocation, "completed", "MCP 工具调用完成。");
      return { content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record(invocation, "failed", message);
      throw error;
    } finally {
      await transport.close().catch(swallowError("close MCP broker transport after callTool"));
    }
  }

  private record(invocation: EchoInkMcpBrokerInvocation, status: EchoInkMcpToolCallLogEntry["status"], message: string): void {
    recordMcpToolCall(this.options.settings, {
      id: `mcp-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      resourceId: invocation.resource.id,
      resourceName: invocation.resource.name,
      scope: invocation.scope,
      backend: invocation.backend,
      toolName: invocation.toolName,
      status,
      message
    });
  }
}

async function initializeMcpClient(transport: EchoInkMcpBrokerTransport, timeoutMs = 30000): Promise<void> {
  await transport.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "EchoInk", version: "1.0.0" }
  }, timeoutMs);
  await transport.notify?.("notifications/initialized", {});
}

export function recordMcpToolCall(settings: EchoInkMcpBrokerSettings, entry: EchoInkMcpToolCallLogEntry): void {
  settings.callLog = [...(settings.callLog ?? []), entry].slice(-100);
}

async function createDefaultMcpTransport(config: EchoInkMcpConnectionConfig): Promise<EchoInkMcpBrokerTransport> {
  if (config.transport === "http") return new HttpMcpTransport(config);
  return await StdioMcpTransport.start(config);
}

class HttpMcpTransport implements EchoInkMcpBrokerTransport {
  private nextId = 1;
  constructor(private readonly config: Extract<EchoInkMcpConnectionConfig, { transport: "http" }>) {}

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.config.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params: params ?? {} }),
        signal: controller.signal
      });
      const data = await response.json();
      if (!response.ok || data?.error) throw new Error(String(data?.error?.message ?? `MCP HTTP ${response.status}`));
      return data?.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await fetch(this.config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.config.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })
    }).catch(swallowError("send HTTP MCP notification"));
  }

  async close(): Promise<void> {}
}

class StdioMcpTransport extends JsonRpcStdioTransport implements EchoInkMcpBrokerTransport {
  private constructor(private readonly config: Extract<EchoInkMcpConnectionConfig, { transport: "stdio" }>) {
    super({
      closedMessage: "MCP transport closed",
      disposeMessage: "MCP transport closed",
      timeoutMessage: (method) => `MCP request timed out: ${method}`,
      exitMessage: (code) => `MCP server exited with code ${code ?? "unknown"}`,
      disableTimeoutForNonPositive: false
    });
  }

  static async start(config: Extract<EchoInkMcpConnectionConfig, { transport: "stdio" }>): Promise<StdioMcpTransport> {
    const transport = new StdioMcpTransport(config);
    transport.start();
    return transport;
  }

  protected buildCommand(): JsonRpcStdioLaunch {
    return {
      command: this.config.command,
      args: this.config.args ?? [],
      cwd: this.config.cwd || process.cwd(),
      env: { ...process.env, ...(this.config.env ?? {}) }
    };
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    return await super.request<T>(method, params ?? {}, timeoutMs);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    super.notify(method, params ?? {});
  }

  async close(): Promise<void> {
    await this.dispose();
  }

  protected handleMessage(_message: JsonRpcMessage): void {
    // MCP responses are handled by the shared transport; broker notifications are ignored.
  }

  protected formatResponseError(message: JsonRpcMessage): Error {
    return new Error(String(message.error?.message ?? "MCP request failed"));
  }
}

function normalizeMcpToolCallLogEntry(value: any): EchoInkMcpToolCallLogEntry | null {
  if (!value || typeof value !== "object" || typeof value.resourceId !== "string" || typeof value.toolName !== "string") return null;
  const status = value.status === "approved" || value.status === "denied" || value.status === "completed" || value.status === "failed" ? value.status : "failed";
  return {
    id: typeof value.id === "string" ? value.id : `mcp-call-${Date.now()}`,
    createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? Math.max(0, value.createdAt) : Date.now(),
    resourceId: value.resourceId,
    resourceName: typeof value.resourceName === "string" ? value.resourceName : value.resourceId,
    scope: value.scope === "chat" || value.scope === "knowledge" || value.scope === "editor-actions" ? value.scope : "chat",
    backend: typeof value.backend === "string" ? value.backend : "",
    toolName: value.toolName,
    status,
    message: typeof value.message === "string" ? value.message : ""
  };
}
