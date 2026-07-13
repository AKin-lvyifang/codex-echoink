import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { EchoInkMcpConnectionConfig, EchoInkResource, EchoInkResourceScope } from "./types";
import {
  initializeVaultResourceStore,
  loadVaultResourceStore,
  type VaultConnectionValue,
  type VaultMcpConnection,
  type VaultResourceCatalogItem,
  type VaultResourceStore,
  vaultResourceLayout
} from "../harness/resources/vault-store";
import { resourceRefToUri } from "../harness/resources/resource-ref";

export interface LoadVaultEchoInkResourcesInput {
  vaultPath: string;
  maxSkillBytes: number;
}

export interface LoadVaultEchoInkResourcesResult {
  resources: EchoInkResource[];
  warnings: string[];
}

export interface ImportEchoInkResourceToVaultInput {
  vaultPath: string;
  resource: EchoInkResource;
  connection?: EchoInkMcpConnectionConfig;
}

export interface ImportEchoInkResourceToVaultResult {
  resourceId: string;
  uri: string;
  relativePath: string;
}

export async function loadVaultEchoInkResources(input: LoadVaultEchoInkResourcesInput): Promise<LoadVaultEchoInkResourcesResult> {
  const store = await loadVaultResourceStore(input);
  return echoInkResourcesFromVaultResourceStore(store);
}

export async function importEchoInkResourceToVault(input: ImportEchoInkResourceToVaultInput): Promise<ImportEchoInkResourceToVaultResult> {
  if (input.resource.source === "echoink-local") throw new Error("该资源已经是 EchoInk Vault 资源。");
  await initializeVaultResourceStore({ vaultPath: input.vaultPath });
  if (input.resource.kind === "skill") return await importSkillResourceToVault(input.vaultPath, input.resource);
  if (input.resource.kind === "mcp-server") return await importMcpResourceToVault(input.vaultPath, input.resource, input.connection);
  throw new Error("当前只支持导入 Skill 和 MCP 资源。");
}

export function echoInkResourcesFromVaultResourceStore(store: VaultResourceStore): LoadVaultEchoInkResourcesResult {
  const resources: EchoInkResource[] = [];
  const warnings: string[] = [...store.warnings];
  for (const item of store.catalog) {
    const scopes = scopesForCatalogItem(store, item);
    if (!scopes.length) continue;
    if (item.kind === "skill") {
      resources.push({
        id: localResourceId("skill", item.ref.resourceId),
        kind: "skill",
        source: "echoink-local",
        name: item.name || item.ref.resourceId,
        description: item.description || "",
        enabled: enabledForCatalogItem(store, item),
        scopes,
        bridgeMode: "prompt-only",
        contentPath: item.ref.resourceId,
        metadata: {
          uri: item.uri,
          version: item.version,
          contentHash: item.contentHash
        }
      });
      continue;
    }
    const connection = store.connections[item.uri];
    const mcp = connection ? inlineMcpConfig(connection) : null;
    if (connection && !mcp) warnings.push(`${item.uri} 使用 secret-ref，需在插件私有连接配置中补全后才能调用。`);
    resources.push({
      id: localResourceId("mcp-server", item.ref.resourceId),
      kind: "mcp-server",
      source: "echoink-local",
      name: item.name || item.ref.resourceId.replace(/^mcp\//, ""),
      description: item.description || "",
      enabled: enabledForCatalogItem(store, item),
      scopes,
      bridgeMode: "structured-tools",
      contentPath: item.ref.resourceId,
      configPath: item.uri,
      metadata: {
        uri: item.uri,
        version: item.version,
        ...(mcp ? { mcp } : {})
      }
    });
  }
  return { resources, warnings };
}

function scopesForCatalogItem(store: VaultResourceStore, item: VaultResourceCatalogItem): EchoInkResourceScope[] {
  const bindings = store.bindings.filter((binding) => sameResource(binding.uri, item.uri) && binding.enabled);
  if (!bindings.length) return ["chat", "knowledge", "editor-actions"];
  const scopes = new Set<EchoInkResourceScope>();
  for (const binding of bindings) {
    for (const scope of binding.scopes) {
      if (scope === "chat" || scope === "knowledge" || scope === "editor-actions") scopes.add(scope);
    }
  }
  return Array.from(scopes);
}

function enabledForCatalogItem(store: VaultResourceStore, item: VaultResourceCatalogItem): boolean {
  const bindings = store.bindings.filter((binding) => sameResource(binding.uri, item.uri));
  return bindings.length ? bindings.some((binding) => binding.enabled) : true;
}

function inlineMcpConfig(connection: VaultMcpConnection): EchoInkMcpConnectionConfig | null {
  const headers = literalRecord(connection.headers);
  const env = literalRecord(connection.env);
  if (headers === null || env === null) return null;
  if (connection.transport === "http") {
    if (!connection.url) return null;
    return {
      transport: "http",
      url: connection.url,
      ...(headers ? { headers } : {})
    };
  }
  if (!connection.command) return null;
  return {
    transport: "stdio",
    command: connection.command,
    ...(connection.args?.length ? { args: connection.args } : {}),
    ...(connection.cwd ? { cwd: connection.cwd } : {}),
    ...(env ? { env } : {})
  };
}

function literalRecord(values: Record<string, VaultConnectionValue> | undefined): Record<string, string> | null | undefined {
  if (!values) return undefined;
  const literals: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value.type !== "literal") return null;
    literals[key] = value.value;
  }
  return literals;
}

function sameResource(left: string, right: string): boolean {
  return left === right;
}

function localResourceId(kind: EchoInkResource["kind"], resourceId: string): string {
  return `echoink-local:${kind}:${normalizeResourceId(resourceId)}`;
}

function normalizeResourceId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "resource";
}

async function importSkillResourceToVault(vaultPath: string, resource: EchoInkResource): Promise<ImportEchoInkResourceToVaultResult> {
  const layout = vaultResourceLayout(vaultPath);
  const resourceId = normalizeResourceId(resource.contentPath || resource.name || resource.id);
  const skillRoot = path.join(layout.skills, resourceId);
  const skillPath = path.join(skillRoot, "SKILL.md");
  await assertMissing(skillPath, `EchoInk Skill 已存在：${resourceId}`);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(skillPath, skillDocumentForImportedResource(resourceId, resource), "utf8");
  await upsertVaultBinding(vaultPath, `echoink://vault/${resourceId}`, resource.scopes);
  return {
    resourceId,
    uri: `echoink://vault/${resourceId}`,
    relativePath: `.echoink/resources/skills/${resourceId}/SKILL.md`
  };
}

async function importMcpResourceToVault(vaultPath: string, resource: EchoInkResource, connection?: EchoInkMcpConnectionConfig): Promise<ImportEchoInkResourceToVaultResult> {
  if (!connection) throw new Error("导入 MCP 到 EchoInk 前，需要先补全 EchoInk 连接配置。");
  const layout = vaultResourceLayout(vaultPath);
  const resourceId = normalizeResourceId(resource.name || resource.configPath || resource.id);
  const serverId = resourceId.replace(/^mcp-/, "");
  const servers = await readJson<{ servers?: Record<string, unknown> }>(layout.mcpServers, { servers: {} });
  if (servers.servers?.[serverId]) throw new Error(`EchoInk MCP 已存在：${serverId}`);
  servers.servers = {
    ...(servers.servers ?? {}),
    [serverId]: mcpServerConfigForVault(connection)
  };
  await writeJson(layout.mcpServers, servers);
  await upsertVaultBinding(vaultPath, `echoink://vault/mcp/${serverId}`, resource.scopes);
  return {
    resourceId: `mcp/${serverId}`,
    uri: `echoink://vault/mcp/${serverId}`,
    relativePath: ".echoink/resources/mcp/servers.json"
  };
}

function skillDocumentForImportedResource(resourceId: string, resource: EchoInkResource): string {
  return [
    "---",
    `id: ${resourceId}`,
    `name: ${yamlString(resource.name || resourceId)}`,
    "version: imported",
    `description: ${yamlString(resource.description || `Imported from ${resource.source}`)}`,
    `scopes: [${resource.scopes.join(", ")}]`,
    "permissions: [vault-read]",
    "entry: instruction",
    "---",
    "",
    `# ${resource.name || resourceId}`,
    "",
    resource.description || `Imported from ${resource.source}.`,
    "",
    `Imported source: ${resource.source}`,
    resource.contentPath ? `Original content path: ${resource.contentPath}` : ""
  ].filter((line) => line !== "").join("\n");
}

function mcpServerConfigForVault(connection: EchoInkMcpConnectionConfig): Record<string, unknown> {
  if (connection.transport === "http") {
    return {
      transport: "http",
      url: connection.url
    };
  }
  return {
    transport: "stdio",
    command: connection.command,
    ...(connection.args?.length ? { args: connection.args } : {}),
    ...(connection.cwd ? { cwd: connection.cwd } : {})
  };
}

async function upsertVaultBinding(vaultPath: string, uri: string, scopes: EchoInkResourceScope[]): Promise<void> {
  const layout = vaultResourceLayout(vaultPath);
  const data = await readJson<{ bindings?: Array<{ ref?: string; scopes?: string[]; enabled?: boolean }> }>(layout.bindings, { bindings: [] });
  const existing = data.bindings?.find((binding) => binding.ref === uri);
  if (existing) {
    existing.scopes = scopes;
    existing.enabled = true;
  } else {
    data.bindings = [...(data.bindings ?? []), { ref: uri, scopes, enabled: true }];
  }
  await writeJson(layout.bindings, data);
}

async function assertMissing(filePath: string, message: string): Promise<void> {
  const existing = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (existing) throw new Error(message);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  const text = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (!text.trim()) return fallback;
  return JSON.parse(text) as T;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
