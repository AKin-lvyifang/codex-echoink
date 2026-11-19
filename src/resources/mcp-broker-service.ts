import type CodexForObsidianPlugin from "../main";
import {
  EchoInkMcpBroker,
  type EchoInkMcpBrokerTransport
} from "./mcp-broker";
import {
  EchoInkMcpCredentialStore,
  materializeMcpCredential,
  mcpSafeTransportPoolKey
} from "./mcp-credential-store";
import { resolveMcpConnectionRecord } from "./mcp-connections";
import type {
  EchoInkMcpConnectionConfig,
  EchoInkMcpConnectionRecord,
  EchoInkResource,
  EchoInkResourceSettings
} from "./types";

export interface CallEchoInkMcpToolInput {
  resourceId: string;
  backend: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EchoInkMcpBrokerPort {
  listTools(
    resource: EchoInkResource,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<{ tools: unknown[] }>;
  callTool(input: {
    resource: EchoInkResource;
    toolName: string;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ content: unknown }>;
}

export interface EchoInkMcpBrokerServiceDependencies {
  readonly transportFactory?: (
    config: EchoInkMcpConnectionConfig
  ) => Promise<EchoInkMcpBrokerTransport>;
  readonly credentialResolver?: (
    resource: EchoInkResource,
    connection: EchoInkMcpConnectionRecord
  ) => Promise<string>;
}

export class EchoInkMcpBrokerService {
  private credentialStore: EchoInkMcpCredentialStore | null = null;
  private readonly createBroker: (
    connections: CodexForObsidianPlugin["settings"]["resources"]["mcpConnections"]
  ) => EchoInkMcpBrokerPort;

  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly dependencies: EchoInkMcpBrokerServiceDependencies = {}
  ) {
    this.createBroker = (connections) => this.createDefaultBroker(connections);
  }

  async listTools(
    resourceId: string,
    timeoutMs = 30000,
    signal?: AbortSignal
  ): Promise<unknown[]> {
    const resource = await this.currentResource(resourceId);
    if (!resource || resource.kind !== "mcp-server") throw new Error("mcp_server_not_found");
    const broker = this.createBroker(this.plugin.settings.resources.mcpConnections);
    return (await broker.listTools(resource, timeoutMs, signal)).tools;
  }

  async callTool(input: CallEchoInkMcpToolInput): Promise<unknown> {
    if (input.backend !== "pi-native") {
      throw new Error("mcp_request_failed");
    }
    const resource = await this.currentResource(input.resourceId);
    if (!resource || resource.kind !== "mcp-server") throw new Error("mcp_server_not_found");
    const broker = this.createBroker(this.plugin.settings.resources.mcpConnections);
    return (await broker.callTool({
      resource,
      toolName: input.toolName,
      arguments: input.arguments,
      timeoutMs: input.timeoutMs,
      signal: input.signal
    })).content;
  }

  async callToolFromResourceSnapshot(
    input: CallEchoInkMcpToolInput,
    snapshot: Readonly<EchoInkResourceSettings>
  ): Promise<unknown> {
    if (input.backend !== "pi-native") {
      throw new Error("mcp_request_failed");
    }
    const resource = snapshot.catalog.find((candidate) =>
      candidate.id === input.resourceId && candidate.kind === "mcp-server"
    );
    if (!resource) throw new Error("mcp_server_not_found");
    const broker = this.createBroker(snapshot.mcpConnections);
    return (await broker.callTool({
      resource,
      toolName: input.toolName,
      arguments: input.arguments,
      timeoutMs: input.timeoutMs,
      signal: input.signal
    })).content;
  }

  private async currentResource(resourceId: string): Promise<EchoInkResource | null> {
    return (await this.plugin.buildRuntimeEchoInkResourceCatalog()).find((resource) => resource.id === resourceId) ?? null;
  }

  private getCredentialStore(): EchoInkMcpCredentialStore {
    if (!this.credentialStore) {
      this.credentialStore = new EchoInkMcpCredentialStore({
        app: this.plugin.app,
        vaultPath: this.plugin.getVaultPath()
      });
    }
    return this.credentialStore;
  }

  private createDefaultBroker(
    connections: CodexForObsidianPlugin["settings"]["resources"]["mcpConnections"]
  ): EchoInkMcpBrokerPort {
    const settings = { mcpConnections: connections };
    return new EchoInkMcpBroker({
      connections,
      ...(this.dependencies.transportFactory
        ? { transportFactory: this.dependencies.transportFactory }
        : {}),
      credentialResolver: async (resource, config) => {
        const record = resolveMcpConnectionRecord(resource, settings);
        if (!record?.credential) return config;
        const secret = this.dependencies.credentialResolver
          ? await this.dependencies.credentialResolver(resource, record)
          : await this.getCredentialStore().resolve(resource, record);
        return materializeMcpCredential(config, record.credential, secret);
      },
      transportPoolKey: (resource, config) =>
        mcpSafeTransportPoolKey(
          resource,
          config,
          resolveMcpConnectionRecord(resource, settings) ?? undefined
        )
    });
  }

}
