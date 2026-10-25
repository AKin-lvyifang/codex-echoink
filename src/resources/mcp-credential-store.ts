import { createHash, randomUUID } from "node:crypto";
import type { App } from "obsidian";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import { readVaultIdentity } from "../plugin/vault-identity";
import {
  DeviceCredentialResolver,
  createCredentialRef,
  createDeviceCredentialRegistry,
  createSecretId,
  parseDeviceCredentialRegistry,
  type CredentialAudience,
  type DeviceCredentialRegistryEntry,
  type DeviceCredentialRegistryV1
} from "../harness/pi/device-credential-registry";
import {
  DeviceCredentialRegistryJournal,
  DeviceCredentialRegistryJournalError
} from "../harness/pi/device-credential-registry-journal";
import { ObsidianSecretStorageAdapter } from "../harness/pi/obsidian-secret-storage";
import { createProviderTargetIdentity } from "../harness/pi/provider-target-identity";
import {
  defaultEchoInkDeviceStateRoot,
  prepareEchoInkCredentialDeviceScope
} from "../plugin/credential-device-scope";
import type {
  EchoInkMcpConnectionConfig,
  EchoInkMcpConnectionRecord,
  EchoInkMcpCredentialBinding,
  EchoInkMcpCredentialPurpose,
  EchoInkResource
} from "./types";

const MAX_CAS_ATTEMPTS = 3;

export interface PutEchoInkMcpCredentialInput {
  readonly resource: EchoInkResource;
  readonly connection: EchoInkMcpConnectionRecord;
  readonly purpose: EchoInkMcpCredentialPurpose;
  readonly targetName: string;
  readonly prefix?: string;
  readonly endpointRevision: number;
  readonly secret: string;
}

/**
 * MCP Credential authority backed by the same per-device Registry and
 * Obsidian SecretStorage used by Provider credentials.
 */
export class EchoInkMcpCredentialStore {
  constructor(private readonly options: {
    readonly app: Pick<App, "secretStorage">;
    readonly vaultPath: string;
    readonly stateRootPath?: string;
  }) {}

  async put(input: Readonly<PutEchoInkMcpCredentialInput>): Promise<EchoInkMcpCredentialBinding> {
    const scope = await this.scope();
    const registry = await this.registry(scope);
    const secrets = new ObsidianSecretStorageAdapter(this.options.app);
    const credentialRef = createCredentialRef();
    const secretId = createSecretId();
    const audience = buildMcpCredentialAudience({
      resource: input.resource,
      connection: input.connection,
      purpose: input.purpose,
      targetName: input.targetName,
      prefix: input.prefix,
      endpointRevision: input.endpointRevision
    });
    const createdAt = new Date().toISOString();
    const entry: DeviceCredentialRegistryEntry = Object.freeze({
      credentialRef,
      secretId,
      purpose: input.purpose,
      audience,
      state: "write_intent",
      createdAt,
      rotatedAt: null
    });
    const existingSecretIds = new Set(secrets.listSecrets());
    if (existingSecretIds.has(secretId)) {
      throw new Error("mcp_credential_secret_collision");
    }
    await appendCredentialEntry(registry, scope, entry);
    try {
      await secrets.setAndReadback(secretId, input.secret);
    } catch (error) {
      await updateCredentialState(registry, scope, credentialRef, "orphaned").catch(() => undefined);
      throw error;
    }
    await updateCredentialState(registry, scope, credentialRef, "active");
    const binding: EchoInkMcpCredentialBinding = Object.freeze({
      credentialRef,
      purpose: input.purpose,
      targetName: input.targetName,
      ...(input.prefix ? { prefix: input.prefix } : {}),
      endpointRevision: input.endpointRevision
    });
    try {
      await this.resolve(input.resource, { ...input.connection, credential: binding });
    } catch (error) {
      await updateCredentialState(registry, scope, credentialRef, "orphaned").catch(() => undefined);
      throw error;
    }
    return binding;
  }

  async resolve(
    resource: EchoInkResource,
    connection: EchoInkMcpConnectionRecord
  ): Promise<string> {
    const binding = connection.credential;
    if (!binding) throw new Error("mcp_credential_not_configured");
    const scope = await this.scope();
    const registry = await this.registry(scope);
    const snapshot = parseDeviceCredentialRegistry(await registry.readRegistry(scope));
    const resolver = new DeviceCredentialResolver({
      registryReader: registry,
      secretStorage: new ObsidianSecretStorageAdapter(this.options.app)
    });
    return await resolver.resolve({
      credentialRef: binding.credentialRef,
      deviceIdDigest: scope.deviceIdDigest,
      vaultIdDigest: scope.vaultIdDigest,
      purpose: binding.purpose,
      audience: buildMcpCredentialAudience({
        resource,
        connection,
        purpose: binding.purpose,
        targetName: binding.targetName,
        prefix: binding.prefix,
        endpointRevision: binding.endpointRevision
      }),
      expectedRegistryRevision: snapshot.revision,
      expectedRegistryDigest: snapshot.digest
    });
  }

  async revoke(credentialRef: string): Promise<void> {
    if (!credentialRef) return;
    const scope = await this.scope();
    const registry = await this.registry(scope);
    await updateCredentialState(registry, scope, credentialRef, "revoked");
  }

  private async scope() {
    const identity = await readVaultIdentity(pluginDataDir(this.options.vaultPath));
    return await prepareEchoInkCredentialDeviceScope({
      stateRootPath: this.options.stateRootPath ?? defaultEchoInkDeviceStateRoot(),
      vaultPath: this.options.vaultPath,
      vaultId: identity?.vaultId
    });
  }

  private async registry(scope: Awaited<ReturnType<EchoInkMcpCredentialStore["scope"]>>) {
    return await DeviceCredentialRegistryJournal.open({
      stateRootPath: scope.stateRootPath,
      deviceIdDigest: scope.deviceIdDigest,
      vaultIdDigest: scope.vaultIdDigest
    });
  }
}

export function materializeMcpCredential(
  config: EchoInkMcpConnectionConfig,
  binding: EchoInkMcpCredentialBinding,
  secret: string
): EchoInkMcpConnectionConfig {
  if (binding.purpose === "mcp_header") {
    if (config.transport !== "http") throw new Error("mcp_credential_transport_mismatch");
    return {
      ...config,
      headers: {
        ...(config.headers ?? {}),
        [binding.targetName]: `${binding.prefix ?? ""}${secret}`
      }
    };
  }
  if (config.transport !== "stdio") throw new Error("mcp_credential_transport_mismatch");
  return {
    ...config,
    env: {
      ...(config.env ?? {}),
      [binding.targetName]: `${binding.prefix ?? ""}${secret}`
    }
  };
}

export function mcpSafeTransportPoolKey(
  resource: EchoInkResource,
  config: EchoInkMcpConnectionConfig,
  connection?: EchoInkMcpConnectionRecord
): string {
  return `mcp:${sha256(JSON.stringify(stableJson({
    resourceId: resource.id,
    config,
    credentialRef: connection?.credential?.credentialRef ?? null
  })))}`;
}

export function buildMcpCredentialAudience(input: {
  readonly resource: EchoInkResource;
  readonly connection: EchoInkMcpConnectionRecord;
  readonly purpose: EchoInkMcpCredentialPurpose;
  readonly targetName: string;
  readonly prefix?: string;
  readonly endpointRevision: number;
}): CredentialAudience {
  const targetBinding = sha256(JSON.stringify(stableJson({
    resourceId: input.resource.id,
    transport: input.connection.transport,
    targetName: input.targetName,
    prefix: input.prefix ?? "",
    purpose: input.purpose
  })));
  const endpoint = input.connection.transport === "http"
    ? input.connection.url
    : `http://127.0.0.1:1/echoink-mcp-stdio/${sha256(JSON.stringify(stableJson({
      command: input.connection.command,
      args: input.connection.args ?? [],
      cwd: input.connection.cwd ?? ""
    })))}`;
  const parsed = new URL(endpoint);
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "::1"
    || parsed.hostname === "[::1]";
  const transport = parsed.protocol === "https:" ? "https" as const : "http" as const;
  const target = createProviderTargetIdentity({
    providerId: `mcp.${targetBinding}`,
    endpointRevision: input.endpointRevision,
    endpoint,
    networkClass: loopback ? "local_loopback" : "cloud_public",
    transport,
    redirectMode: "deny",
    redirectMaxHops: 0,
    routeMode: "direct"
  });
  return Object.freeze({
    kind: "mcp",
    bindingIdDigest: target.digest,
    endpointId: `mcp-${sha256(input.resource.id).slice(0, 32)}`,
    endpointRevision: target.identity.endpointRevision,
    canonicalOrigin: target.identity.canonicalOrigin,
    pathPrefixDigest: target.identity.pathScopeDigest,
    transport,
    credentialTargetIdentityDigest: target.digest,
    proxyTargetIdentityDigest: null
  });
}

type CredentialScope = Readonly<{
  stateRootPath: string;
  deviceIdDigest: string;
  vaultIdDigest: string;
}>;

async function appendCredentialEntry(
  registry: DeviceCredentialRegistryJournal,
  scope: CredentialScope,
  entry: DeviceCredentialRegistryEntry
): Promise<void> {
  await mutateRegistry(registry, scope, entry.credentialRef, (current) => {
    if (current?.entries.some((candidate) => candidate.credentialRef === entry.credentialRef)) {
      throw new Error("mcp_credential_ref_collision");
    }
    return [...(current?.entries ?? []), entry];
  });
}

async function updateCredentialState(
  registry: DeviceCredentialRegistryJournal,
  scope: CredentialScope,
  credentialRef: string,
  state: DeviceCredentialRegistryEntry["state"]
): Promise<void> {
  await mutateRegistry(registry, scope, credentialRef, (current) => {
    if (!current) throw new Error("mcp_credential_registry_missing");
    let found = false;
    const entries = current.entries.map((entry) => {
      if (entry.credentialRef !== credentialRef) return entry;
      found = true;
      return Object.freeze({
        ...entry,
        state,
        rotatedAt: state === "revoked" ? new Date().toISOString() : entry.rotatedAt
      });
    });
    if (!found) throw new Error("mcp_credential_ref_missing");
    return entries;
  });
}

async function mutateRegistry(
  registry: DeviceCredentialRegistryJournal,
  scope: CredentialScope,
  credentialRef: string,
  mutate: (current: DeviceCredentialRegistryV1 | null) => readonly DeviceCredentialRegistryEntry[]
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await registry.readRegistry(scope);
    const current = raw === null ? null : parseDeviceCredentialRegistry(raw);
    const entries = mutate(current);
    const target = createDeviceCredentialRegistry({
      deviceIdDigest: scope.deviceIdDigest,
      vaultIdDigest: scope.vaultIdDigest,
      revision: (current?.revision ?? 0) + 1,
      previousDigest: current?.digest ?? null,
      commitId: `mcp-credential-${randomUUID()}`,
      entries
    });
    try {
      await registry.compareAndSwap({
        expectedRevision: current?.revision ?? null,
        expectedDigest: current?.digest ?? null,
        credentialRef,
        target
      });
      return;
    } catch (error) {
      if (!(error instanceof DeviceCredentialRegistryJournalError) || error.code !== "cas_conflict") {
        throw error;
      }
    }
  }
  throw new Error("mcp_credential_registry_busy");
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, raw]) => [key, stableJson(raw)]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
