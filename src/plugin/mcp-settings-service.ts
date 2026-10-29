import { getDesktopCrypto } from "../platform/desktop-crypto";
import type { App } from "obsidian";
import { EchoInkMcpBrokerError, closeMcpBrokerConnectionPool } from "../resources/mcp-broker";
import { EchoInkMcpCredentialStore } from "../resources/mcp-credential-store";
import {
  mcpToolContractsMatch,
  resolveMcpConnectionRecord
} from "../resources/mcp-connections";
import { inspectMcpToolList } from "../resources/mcp-tool-catalog";
import type {
  EchoInkMcpConnectionRecord,
  EchoInkMcpCredentialPurpose,
  EchoInkMcpDiagnostic,
  EchoInkMcpDiagnosticCode,
  EchoInkMcpDiscoveredTool,
  EchoInkMcpToolPolicy,
  EchoInkResource
} from "../resources/types";
import type { CodexForObsidianSettings } from "../settings/settings";
import {
  ResourceMutationError,
  resourceMutationRollbackIsSafe,
  runResourceMutationWithReload
} from "./resource-mutation-authority";

const { createHash, randomUUID } = getDesktopCrypto();

export interface EchoInkMcpServerDraft {
  readonly resourceId?: string;
  readonly name: string;
  readonly description?: string;
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credential?: Readonly<{
    purpose: EchoInkMcpCredentialPurpose;
    targetName: string;
    prefix?: string;
    secret?: string;
    clear?: boolean;
  }>;
}

export interface EchoInkMcpSettingsHost {
  readonly app: Pick<App, "secretStorage">;
  readonly settings: CodexForObsidianSettings;
  getVaultPath(): string;
  saveSettings(force?: boolean): Promise<void>;
  withEchoInkResourceMutation<R>(action: () => Promise<R>): Promise<R>;
  saveEchoInkResourceMutation(
    previous: CodexForObsidianSettings["resources"]
  ): Promise<void>;
  reloadPiProductionRuntime(): Promise<void>;
  buildRuntimeEchoInkResourceCatalog(): Promise<EchoInkResource[]>;
  listEchoInkMcpTools(
    resourceId: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<unknown[]>;
}

export class EchoInkMcpSettingsService {
  private credentialStore: EchoInkMcpCredentialStore | null = null;

  constructor(private readonly host: EchoInkMcpSettingsHost) {}

  async saveServer(draft: Readonly<EchoInkMcpServerDraft>): Promise<EchoInkResource> {
    const normalized = normalizeDraft(draft);
    const discoveredResource = normalized.resourceId
      ? await this.resource(normalized.resourceId)
      : null;
    if (normalized.resourceId && !discoveredResource) {
      throw new Error("mcp_server_not_found");
    }
    return await this.host.withEchoInkResourceMutation(async () => {
      const existingResource = normalized.resourceId
        ? this.currentResource(normalized.resourceId)
        : null;
      if (normalized.resourceId && !existingResource) {
        throw new Error("mcp_server_not_found");
      }
      const resourceId = existingResource?.id ?? createMcpResourceId(normalized.name);
      const previousConnection = this.host.settings.resources.mcpConnections[resourceId];
      const endpointRevision = nextCredentialEndpointRevision(previousConnection, normalized);
      let connection = connectionFromDraft(normalized, previousConnection);
      let credentialToRevoke = "";
      let createdCredentialRef = "";
      if (normalized.credential?.clear) {
        credentialToRevoke = previousConnection?.credential?.credentialRef ?? "";
        delete connection.credential;
      } else if (normalized.credential?.secret) {
        const resource = resourceFromDraft(resourceId, normalized, existingResource);
        const binding = await this.getCredentialStore().put({
          resource,
          connection,
          purpose: normalized.credential.purpose,
          targetName: normalized.credential.targetName,
          prefix: normalized.credential.prefix,
          endpointRevision,
          secret: normalized.credential.secret
        });
        createdCredentialRef = binding.credentialRef;
        credentialToRevoke = previousConnection?.credential?.credentialRef ?? "";
        connection = { ...connection, credential: binding };
      } else if (
        previousConnection?.credential
        && (!normalized.credential || sameCredentialTarget(previousConnection, normalized))
        && connectionTargetIdentity(previousConnection) === draftTargetIdentity(normalized)
      ) {
        connection = { ...connection, credential: previousConnection.credential };
      } else if (previousConnection?.credential) {
        credentialToRevoke = previousConnection.credential.credentialRef;
        delete connection.credential;
      }

      const resource = resourceFromDraft(resourceId, normalized, existingResource);
      try {
        await this.mutateAndReload(() => {
          upsertResource(this.host.settings.resources.catalog, resource);
          this.host.settings.resources.mcpConnections[resourceId] = connection;
        });
      } catch (error) {
        if (
          createdCredentialRef
          && resourceMutationRollbackIsSafe(error)
          && !(error as ResourceMutationError).candidateMayBePersisted
        ) {
          await this.getCredentialStore().revoke(createdCredentialRef).catch(() => undefined);
        }
        throw error;
      }
      if (credentialToRevoke && credentialToRevoke !== connection.credential?.credentialRef) {
        await this.getCredentialStore().revoke(credentialToRevoke).catch(() => undefined);
      }
      return resource;
    });
  }

  async deleteServer(resourceId: string): Promise<void> {
    await this.requireResource(resourceId);
    await this.host.withEchoInkResourceMutation(async () => {
      const resource = this.currentResource(resourceId);
      if (!resource) throw new Error("mcp_server_not_found");
      if (resource.source !== "manual") throw new Error("mcp_server_delete_not_allowed");
      const credentialRef = this.host.settings.resources.mcpConnections[resourceId]
        ?.credential?.credentialRef ?? "";
      await this.mutateAndReload(() => {
        this.host.settings.resources.catalog = this.host.settings.resources.catalog
          .filter((candidate) => candidate.id !== resourceId);
        delete this.host.settings.resources.mcpConnections[resourceId];
      });
      if (credentialRef) {
        await this.getCredentialStore().revoke(credentialRef).catch(() => undefined);
      }
    });
  }

  async refreshServer(
    resourceId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal
  ): Promise<Readonly<{ tools: number; diagnostic?: EchoInkMcpDiagnostic }>> {
    await this.requireResource(resourceId);
    let inspected: ReturnType<typeof inspectMcpToolList>;
    try {
      inspected = inspectMcpToolList(
        await this.host.listEchoInkMcpTools(resourceId, timeoutMs, signal)
      );
    } catch (error) {
      await this.host.withEchoInkResourceMutation(async () => this.mutateAndSave(() => {
        const resource = this.currentResource(resourceId);
        if (!resource) throw new Error("mcp_server_not_found");
        upsertResource(this.host.settings.resources.catalog, resource);
        const connection = this.materializeConnection(resource);
        connection.verifiedAt = undefined;
        connection.diagnostic = diagnosticFromError(error);
        connection.lastError = connection.diagnostic.message;
      }));
      throw error;
    }
    let resultDiagnostic: EchoInkMcpDiagnostic | undefined;
    await this.host.withEchoInkResourceMutation(async () => this.mutateAndReload(() => {
      const resource = this.currentResource(resourceId);
      if (!resource) throw new Error("mcp_server_not_found");
      upsertResource(this.host.settings.resources.catalog, resource);
      const connection = this.materializeConnection(resource);
      connection.toolPolicies = policiesAfterDiscovery(connection, inspected.tools);
      connection.tools = [...inspected.tools];
      connection.toolsFingerprint = inspected.fingerprint;
      connection.discoveredAt = Date.now();
      connection.verifiedAt = connection.discoveredAt;
      connection.lastError = "";
      connection.diagnostic = inspected.warnings.length
        ? diagnostic("schema_invalid", inspected.warnings.join(" "))
        : undefined;
      resultDiagnostic = connection.diagnostic;
    }));
    return Object.freeze({
      tools: inspected.tools.length,
      ...(resultDiagnostic ? { diagnostic: resultDiagnostic } : {})
    });
  }

  async setServerTrusted(resourceId: string, trusted: boolean): Promise<void> {
    await this.requireResource(resourceId);
    await this.host.withEchoInkResourceMutation(async () => {
      const resource = this.currentResource(resourceId);
      if (!resource) throw new Error("mcp_server_not_found");
      const savedConnection = this.host.settings.resources.mcpConnections[resourceId];
      const currentConnection = savedConnection
        ?? resolveMcpConnectionRecord(resource, this.host.settings.resources);
      if (!currentConnection) throw new Error("mcp_connection_not_found");
      if (currentConnection.trusted === trusted) return;
      await this.mutateAndReload(() => {
        upsertResource(this.host.settings.resources.catalog, resource);
        this.materializeConnection(resource).trusted = trusted;
      });
    });
  }

  async setServerEnabled(
    resourceId: string,
    enabled: boolean
  ): Promise<void> {
    await this.requireResource(resourceId);
    await this.host.withEchoInkResourceMutation(async () => {
      const resource = this.currentResource(resourceId);
      if (!resource) throw new Error("mcp_server_not_found");
      if (resource.enabled === enabled) return;
      await this.mutateAndReload(() => {
        upsertResource(this.host.settings.resources.catalog, { ...resource, enabled });
      });
    });
  }

  async setToolPolicy(
    resourceId: string,
    toolName: string,
    patch: Partial<EchoInkMcpToolPolicy>
  ): Promise<void> {
    await this.requireResource(resourceId);
    await this.host.withEchoInkResourceMutation(async () => {
      const resource = this.currentResource(resourceId);
      if (!resource) throw new Error("mcp_server_not_found");
      const currentConnection = this.requireConnection(resourceId);
      if (!currentConnection.tools.some((tool) => tool.name === toolName)) {
        throw new Error("mcp_tool_not_found");
      }
      const current = currentConnection.toolPolicies[toolName] ?? {
        enabled: true,
        trusted: false
      };
      const next = {
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        trusted: typeof patch.trusted === "boolean" ? patch.trusted : current.trusted
      };
      if (next.enabled === current.enabled && next.trusted === current.trusted) return;
      await this.mutateAndReload(() => {
        upsertResource(this.host.settings.resources.catalog, resource);
        const connection = this.requireConnection(resourceId);
        connection.toolPolicies[toolName] = next;
      });
    });
  }

  private async resource(resourceId: string): Promise<EchoInkResource | null> {
    const saved = this.host.settings.resources.catalog.find((candidate) =>
      candidate.id === resourceId && candidate.kind === "mcp-server") ?? null;
    if (saved) return saved;
    return (await this.host.buildRuntimeEchoInkResourceCatalog()).find((candidate) =>
      candidate.id === resourceId && candidate.kind === "mcp-server") ?? null;
  }

  private async requireResource(resourceId: string): Promise<EchoInkResource> {
    const resource = await this.resource(resourceId);
    if (!resource) throw new Error("mcp_server_not_found");
    return resource;
  }

  private currentResource(resourceId: string): EchoInkResource | null {
    return this.host.settings.resources.catalog.find((candidate) =>
      candidate.id === resourceId && candidate.kind === "mcp-server") ?? null;
  }

  private requireConnection(resourceId: string): EchoInkMcpConnectionRecord {
    const connection = this.host.settings.resources.mcpConnections[resourceId];
    if (!connection) throw new Error("mcp_connection_not_found");
    return connection;
  }

  private materializeConnection(resource: EchoInkResource): EchoInkMcpConnectionRecord {
    const existing = this.host.settings.resources.mcpConnections[resource.id];
    if (existing) return existing;
    const resolved = resolveMcpConnectionRecord(resource, this.host.settings.resources);
    if (!resolved) throw new Error("mcp_connection_not_found");
    const materialized = structuredClone(resolved);
    this.host.settings.resources.mcpConnections[resource.id] = materialized;
    return materialized;
  }

  private async mutateAndReload(action: () => void): Promise<void> {
    await runResourceMutationWithReload({
      snapshot: () => structuredClone(this.host.settings.resources),
      restore: (resources) => { this.host.settings.resources = resources; },
      mutate: action,
      save: async (previous) => await this.host.saveEchoInkResourceMutation(previous),
      closeRuntimeResources: async () => await closeMcpBrokerConnectionPool(),
      reloadRuntime: async () => await this.host.reloadPiProductionRuntime()
    });
  }

  private async mutateAndSave(action: () => void): Promise<void> {
    const previous = structuredClone(this.host.settings.resources);
    action();
    await this.host.saveEchoInkResourceMutation(previous);
  }

  private getCredentialStore(): EchoInkMcpCredentialStore {
    if (!this.credentialStore) {
      this.credentialStore = new EchoInkMcpCredentialStore({
        app: this.host.app,
        vaultPath: this.host.getVaultPath()
      });
    }
    return this.credentialStore;
  }
}

function normalizeDraft(draft: Readonly<EchoInkMcpServerDraft>): EchoInkMcpServerDraft {
  const name = draft.name.trim();
  if (!name || name.length > 120) throw new Error("mcp_server_name_invalid");
  const resourceId = draft.resourceId?.trim();
  const description = draft.description?.trim().slice(0, 2_000) ?? "";
  const credential = normalizeCredentialDraft(draft.credential, draft.transport);
  if (draft.transport === "http") {
    const url = draft.url?.trim() ?? "";
    const parsed = safeMcpUrl(url);
    const headers = normalizeStringRecord(draft.headers);
    assertCredentialTargetIsSeparate(headers, credential);
    return {
      ...(resourceId ? { resourceId } : {}),
      name,
      description,
      transport: "http",
      url: parsed.toString(),
      headers,
      ...(credential ? { credential } : {})
    };
  }
  const command = draft.command?.trim() ?? "";
  if (!command || hasLineBreakOrNull(command)) throw new Error("mcp_stdio_command_invalid");
  const env = normalizeStringRecord(draft.env);
  assertCredentialTargetIsSeparate(env, credential);
  return {
    ...(resourceId ? { resourceId } : {}),
    name,
    description,
    transport: "stdio",
    command,
    args: (draft.args ?? []).map((item) => item.trim()).filter(Boolean),
    cwd: draft.cwd?.trim() || undefined,
    env,
    ...(credential ? { credential } : {})
  };
}

function normalizeCredentialDraft(
  value: EchoInkMcpServerDraft["credential"],
  transport: "stdio" | "http"
): EchoInkMcpServerDraft["credential"] | undefined {
  if (!value) return undefined;
  if (value.clear) return Object.freeze({ ...value, clear: true });
  const expectedPurpose = transport === "http" ? "mcp_header" : "mcp_env";
  if (value.purpose !== expectedPurpose) throw new Error("mcp_credential_transport_mismatch");
  const targetName = value.targetName.trim();
  if (transport === "http" && !/^[A-Za-z0-9][A-Za-z0-9-]{0,126}$/u.test(targetName)) {
    throw new Error("mcp_credential_header_invalid");
  }
  if (transport === "stdio" && !/^[A-Za-z_][A-Za-z0-9_]{0,126}$/u.test(targetName)) {
    throw new Error("mcp_credential_env_invalid");
  }
  const prefix = value.prefix ?? "";
  if (prefix.length > 64 || hasLineBreakOrNull(prefix)) throw new Error("mcp_credential_prefix_invalid");
  return Object.freeze({
    purpose: value.purpose,
    targetName,
    ...(prefix ? { prefix } : {}),
    ...(value.secret ? { secret: value.secret } : {})
  });
}

function connectionFromDraft(
  draft: EchoInkMcpServerDraft,
  previous?: EchoInkMcpConnectionRecord
): EchoInkMcpConnectionRecord {
  const sameTransportTarget = Boolean(
    previous && connectionTargetIdentity(previous) === draftTargetIdentity(draft)
  );
  const common = {
    trusted: sameTransportTarget ? previous?.trusted ?? false : false,
    toolPolicies: sameTransportTarget
      ? structuredClone(previous?.toolPolicies ?? {})
      : {},
    tools: sameTransportTarget ? structuredClone(previous?.tools ?? []) : [],
    toolsFingerprint: sameTransportTarget ? previous?.toolsFingerprint : undefined,
    discoveredAt: sameTransportTarget ? previous?.discoveredAt : undefined
  };
  if (draft.transport === "http") {
    return compactConnection({
      transport: "http",
      url: draft.url!,
      headers: draft.headers ? { ...draft.headers } : undefined,
      ...common,
      ...(sameTransportTarget ? {
        verifiedAt: previous?.verifiedAt,
        diagnostic: previous?.diagnostic,
        lastError: previous?.lastError
      } : {})
    });
  }
  return compactConnection({
    transport: "stdio",
    command: draft.command!,
    args: [...(draft.args ?? [])],
    cwd: draft.cwd,
    env: draft.env ? { ...draft.env } : undefined,
    ...common,
    ...(sameTransportTarget ? {
      verifiedAt: previous?.verifiedAt,
      diagnostic: previous?.diagnostic,
      lastError: previous?.lastError
    } : {})
  });
}

function resourceFromDraft(
  id: string,
  draft: EchoInkMcpServerDraft,
  previous: EchoInkResource | null
): EchoInkResource {
  return {
    id,
    kind: "mcp-server",
    source: previous?.source ?? "manual",
    name: draft.name,
    description: draft.description ?? "",
    enabled: previous?.enabled ?? true,
    bridgeMode: "structured-tools"
  };
}

function policiesAfterDiscovery(
  connection: EchoInkMcpConnectionRecord,
  tools: readonly EchoInkMcpDiscoveredTool[]
): Record<string, EchoInkMcpToolPolicy> {
  const policies: Record<string, EchoInkMcpToolPolicy> = {};
  for (const tool of tools) {
    const previousTool = connection.tools.find((candidate) => candidate.name === tool.name);
    const previousPolicy = connection.toolPolicies[tool.name];
    const unchanged = Boolean(previousTool && mcpToolContractsMatch(previousTool, tool));
    policies[tool.name] = {
      enabled: previousPolicy?.enabled ?? true,
      trusted: unchanged ? previousPolicy?.trusted ?? false : false
    };
  }
  return policies;
}

function sameCredentialTarget(
  previous: EchoInkMcpConnectionRecord,
  draft: EchoInkMcpServerDraft
): boolean {
  const binding = previous.credential;
  const requested = draft.credential;
  return Boolean(
    binding
    && requested
    && !requested.clear
    && binding.purpose === requested.purpose
    && binding.targetName === requested.targetName
    && (binding.prefix ?? "") === (requested.prefix ?? "")
    && connectionTargetIdentity(previous) === draftTargetIdentity(draft)
  );
}

function nextCredentialEndpointRevision(
  previous: EchoInkMcpConnectionRecord | undefined,
  draft: EchoInkMcpServerDraft
): number {
  const current = previous?.credential?.endpointRevision ?? 0;
  return previous && connectionTargetIdentity(previous) === draftTargetIdentity(draft)
    ? Math.max(1, current)
    : Math.max(1, current + 1);
}

function connectionTargetIdentity(connection: EchoInkMcpConnectionRecord): string {
  return connection.transport === "http"
    ? JSON.stringify({ transport: "http", url: connection.url })
    : JSON.stringify({
      transport: "stdio",
      command: connection.command,
      args: connection.args ?? [],
      cwd: connection.cwd ?? ""
    });
}

function draftTargetIdentity(draft: EchoInkMcpServerDraft): string {
  return draft.transport === "http"
    ? JSON.stringify({ transport: "http", url: draft.url })
    : JSON.stringify({
      transport: "stdio",
      command: draft.command,
      args: draft.args ?? [],
      cwd: draft.cwd ?? ""
    });
}

function createMcpResourceId(name: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "server";
  return `manual:mcp-server:${slug}-${randomUUID().slice(0, 8)}`;
}

function upsertResource(catalog: EchoInkResource[], resource: EchoInkResource): void {
  const index = catalog.findIndex((candidate) => candidate.id === resource.id);
  if (index >= 0) catalog[index] = resource;
  else catalog.push(resource);
}

function safeMcpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("mcp_http_url_invalid");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new Error("mcp_http_url_invalid");
  }
  return parsed;
}

function normalizeStringRecord(value: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    const name = key.trim();
    const text = raw.trim();
    return name && text && !hasLineBreakOrNull(name)
      ? [[name, text] as const]
      : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function assertCredentialTargetIsSeparate(
  values: Record<string, string> | undefined,
  credential: EchoInkMcpServerDraft["credential"] | undefined
): void {
  if (!values || !credential || credential.clear) return;
  const target = credential.targetName.toLowerCase();
  if (Object.keys(values).some((key) => key.toLowerCase() === target)) {
    throw new Error("mcp_credential_target_duplicate");
  }
}

function diagnostic(code: EchoInkMcpDiagnosticCode, message: string): EchoInkMcpDiagnostic {
  return Object.freeze({
    code,
    message: sanitizeSingleLine(message).slice(0, 500),
    occurredAt: Date.now()
  });
}

function diagnosticFromError(error: unknown): EchoInkMcpDiagnostic {
  if (error instanceof EchoInkMcpBrokerError) {
    return diagnostic(error.code, safeDiagnosticMessage(error.code));
  }
  const message = error instanceof Error ? error.message : String(error);
  const code: EchoInkMcpDiagnosticCode = /credential|auth|unauthori[sz]ed|\b401\b|\b403\b/iu.test(message)
    ? "authentication_failed"
    : /timeout|timed out/iu.test(message)
      ? "timeout"
      : /closed|exited|disconnect|econnreset/iu.test(message)
        ? "disconnected"
        : "connection_failed";
  return diagnostic(code, safeDiagnosticMessage(code));
}

function hasLineBreakOrNull(value: string): boolean {
  return /[\r\n]/u.test(value) || value.includes("\u0000");
}

function sanitizeSingleLine(value: string): string {
  return value.replaceAll("\u0000", " ").replace(/[\r\n]+/gu, " ").trim();
}

function safeDiagnosticMessage(code: EchoInkMcpDiagnosticCode): string {
  if (code === "authentication_failed") return "MCP 认证失败，请检查 Credential。";
  if (code === "timeout") return "MCP 连接或请求超时。";
  if (code === "disconnected") return "MCP Server 已断线。";
  if (code === "schema_invalid") return "MCP Tool Schema 非法。";
  if (code === "call_failed") return "MCP Tool 调用失败。";
  return "MCP 连接失败，请检查传输配置。";
}

function compactConnection<T extends EchoInkMcpConnectionRecord>(connection: T): T {
  return Object.fromEntries(Object.entries(connection).filter(([, value]) => value !== undefined && value !== "")) as T;
}

export function mcpSettingsFingerprint(settings: CodexForObsidianSettings["resources"]): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({
      catalog: settings.catalog.filter((resource) => resource.kind === "mcp-server"),
      connections: settings.mcpConnections
    }), "utf8")
    .digest("hex")}`;
}
