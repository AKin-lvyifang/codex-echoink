import type CodexForObsidianPlugin from "../main";
import { confirmModal } from "../ui/modals";
import { EchoInkMcpBroker } from "./mcp-broker";
import { resolveMcpConnectionConfig } from "./mcp-connections";
import type { EchoInkMcpConnectionRecord, EchoInkResource, EchoInkResourceScope } from "./types";

export interface CallEchoInkMcpToolInput {
  resourceId: string;
  scope: EchoInkResourceScope;
  backend: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
}

export class EchoInkMcpBrokerService {
  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async listTools(resourceId: string, timeoutMs = 30000): Promise<unknown[]> {
    const resource = await this.currentResource(resourceId);
    if (!resource || resource.kind !== "mcp-server") throw new Error("找不到 EchoInk MCP 资源。");
    const broker = new EchoInkMcpBroker({
      settings: this.plugin.settings.resources.mcpBroker,
      connections: this.plugin.settings.resources.mcpConnections
    });
    try {
      const result = await broker.listTools(resource, timeoutMs);
      this.recordConnectionSuccess(resource);
      await this.plugin.saveSettings(true);
      return result.tools;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordConnectionFailure(resource, message);
      await this.plugin.saveSettings(true);
      throw error;
    }
  }

  async callTool(input: CallEchoInkMcpToolInput): Promise<unknown> {
    const resource = await this.currentResource(input.resourceId);
    if (!resource || resource.kind !== "mcp-server") throw new Error("找不到 EchoInk MCP 资源。");
    const broker = new EchoInkMcpBroker({
      settings: this.plugin.settings.resources.mcpBroker,
      connections: this.plugin.settings.resources.mcpConnections,
      approval: async (request) => {
        const args = request.arguments ? `\n\n参数：${JSON.stringify(request.arguments, null, 2).slice(0, 2000)}` : "";
        return await confirmModal(
          this.plugin.app,
          `MCP 工具调用：${request.toolName}`,
          `资源：${request.resource.name}\n后端：${request.backend}\n范围：${request.scope}${args}`,
          "允许",
          "拒绝"
        );
      }
    });
    try {
      const result = await broker.callTool({
        resource,
        scope: input.scope,
        backend: input.backend,
        toolName: input.toolName,
        arguments: input.arguments,
        timeoutMs: input.timeoutMs
      });
      this.recordConnectionSuccess(resource);
      return result.content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordConnectionFailure(resource, message);
      throw error;
    } finally {
      await this.plugin.saveSettings(true);
    }
  }

  private async currentResource(resourceId: string): Promise<EchoInkResource | null> {
    return (await this.plugin.buildRuntimeEchoInkResourceCatalog()).find((resource) => resource.id === resourceId) ?? null;
  }

  private recordConnectionSuccess(resource: EchoInkResource): void {
    const record = this.ensureConnectionRecord(resource);
    if (!record) return;
    record.verifiedAt = Date.now();
    record.lastError = "";
  }

  private recordConnectionFailure(resource: EchoInkResource, message: string): void {
    const record = this.ensureConnectionRecord(resource);
    if (!record) return;
    record.lastError = message;
  }

  private ensureConnectionRecord(resource: EchoInkResource): EchoInkMcpConnectionRecord | null {
    const existing = this.plugin.settings.resources.mcpConnections[resource.id];
    if (existing) return existing;
    const config = resolveMcpConnectionConfig(resource, this.plugin.settings.resources);
    if (!config) return null;
    const record = { ...config };
    this.plugin.settings.resources.mcpConnections[resource.id] = record;
    return record;
  }
}
