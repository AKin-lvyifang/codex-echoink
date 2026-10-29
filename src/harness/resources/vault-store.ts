import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { getDesktopPath } from "../../platform/desktop-paths";

import type { ResourceRef } from "../../resources/types";
import { parseResourceUri, resourceRefToUri } from "./resource-ref";
import { loadVaultSkill } from "./skill-loader";
import { installBuiltinSkillFiles } from "./skill-runtime";

const { mkdir, readdir, readFile, stat, writeFile } = getDesktopFsPromises();
const path = getDesktopPath();

export interface VaultResourceManifest {
  version: 1;
  resourceStoreVersion: 1;
}

export type VaultResourceKind = "skill" | "mcp-server";

export interface VaultResourceCatalogItem {
  ref: ResourceRef;
  uri: string;
  kind: VaultResourceKind;
  name: string;
  version: string;
  description: string;
  contentHash?: string;
}

export interface VaultSecretRef {
  type: "secret-ref";
  name: string;
}

export interface VaultLiteralValue {
  type: "literal";
  value: string;
}

export type VaultConnectionValue = VaultSecretRef | VaultLiteralValue;

export interface VaultMcpConnection {
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  headers?: Record<string, VaultConnectionValue>;
  env?: Record<string, VaultConnectionValue>;
}

export interface VaultResourceBinding {
  ref: ResourceRef;
  uri: string;
  enabled: boolean;
  backendIds?: string[];
}

export interface VaultResourcePolicy {
  approval: "ask" | "deny" | "never";
  network: boolean;
  writeFiles: boolean;
  maxCallsPerRun: number;
  timeoutMs: number;
}

export interface VaultResourceStore {
  manifest: VaultResourceManifest;
  catalog: VaultResourceCatalogItem[];
  connections: Record<string, VaultMcpConnection>;
  bindings: VaultResourceBinding[];
  policies: Record<string, VaultResourcePolicy>;
  warnings: string[];
}

export interface InitializeVaultResourceStoreResult {
  created: string[];
  existing: string[];
}

export interface LoadVaultResourceStoreInput {
  vaultPath: string;
  maxSkillBytes: number;
}

export function vaultResourceLayout(vaultPath: string) {
  const root = path.join(vaultPath, ".echoink");
  const resources = path.join(root, "resources");
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    resources,
    skills: path.join(resources, "skills"),
    mcp: path.join(resources, "mcp"),
    mcpServers: path.join(resources, "mcp", "servers.json"),
    bindings: path.join(resources, "bindings.json"),
    policies: path.join(resources, "policies.json")
  };
}

export async function initializeVaultResourceStore(input: { vaultPath: string }): Promise<InitializeVaultResourceStoreResult> {
  const layout = vaultResourceLayout(input.vaultPath);
  const created: string[] = [];
  const existing: string[] = [];
  for (const dir of [layout.root, layout.resources, layout.skills, layout.mcp]) {
    await ensureDirectory(dir, created, existing);
  }
  await ensureFile(layout.manifest, JSON.stringify({ version: 1, resourceStoreVersion: 1 }, null, 2), created, existing);
  await ensureFile(layout.mcpServers, JSON.stringify({ servers: {} }, null, 2), created, existing);
  await ensureFile(layout.bindings, JSON.stringify({ bindings: [] }, null, 2), created, existing);
  await ensureFile(layout.policies, JSON.stringify({ policies: {} }, null, 2), created, existing);
  await installBuiltinSkillFiles({
    vaultPath: input.vaultPath,
    created,
    existing
  });
  return { created, existing };
}

export async function loadVaultResourceStore(input: LoadVaultResourceStoreInput): Promise<VaultResourceStore> {
  const layout = vaultResourceLayout(input.vaultPath);
  const manifest = await readJsonFile<VaultResourceManifest>(layout.manifest, { version: 1, resourceStoreVersion: 1 });
  const skills = await loadVaultSkillCatalog(input.vaultPath, input.maxSkillBytes);
  const catalog = [
    ...skills.catalog,
    ...await loadVaultMcpCatalog(layout.mcpServers)
  ];
  const connections = await loadVaultMcpConnections(layout.mcpServers);
  const bindings = await loadVaultResourceBindings(layout.bindings);
  const policies = await loadVaultResourcePolicies(layout.policies);
  return {
    manifest,
    catalog,
    connections,
    bindings,
    policies,
    warnings: skills.warnings
  };
}

async function loadVaultSkillCatalog(
  vaultPath: string,
  maxSkillBytes: number
): Promise<Readonly<{
  catalog: VaultResourceCatalogItem[];
  warnings: string[];
}>> {
  const skillsRoot = vaultResourceLayout(vaultPath).skills;
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch((error) => {
    if (isMissingFileSystemError(error)) return [];
    throw error;
  });
  const catalog: VaultResourceCatalogItem[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await loadVaultSkill({
      vaultPath,
      skillId: entry.name,
      maxBytes: maxSkillBytes
    }).catch((error) => {
      if (isMissingFileSystemError(error)) return null;
      warnings.push(
        `Skill ${entry.name} 无法读取：${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    });
    if (!skill) continue;
    const uri = resourceRefToUri(skill.ref);
    catalog.push({
      ref: skill.ref,
      uri,
      kind: "skill",
      name: skill.frontmatter.name,
      version: skill.frontmatter.version,
      description: skill.frontmatter.description,
      contentHash: skill.contentHash
    });
  }
  return {
    catalog: catalog.sort((left, right) => left.uri.localeCompare(right.uri)),
    warnings
  };
}

async function loadVaultMcpCatalog(filePath: string): Promise<VaultResourceCatalogItem[]> {
  const data = await readJsonFile<{ servers?: Record<string, unknown> }>(filePath, { servers: {} });
  return Object.keys(data.servers ?? {}).sort().map((id) => {
    const ref: ResourceRef = { plane: "echoink-vault", resourceId: `mcp/${id}` };
    return {
      ref,
      uri: resourceRefToUri(ref),
      kind: "mcp-server",
      name: id,
      version: "",
      description: "Vault MCP server"
    };
  });
}

async function loadVaultMcpConnections(filePath: string): Promise<Record<string, VaultMcpConnection>> {
  const data = await readJsonFile<{ servers?: Record<string, RawMcpServer> }>(filePath, { servers: {} });
  const connections: Record<string, VaultMcpConnection> = {};
  for (const [id, raw] of Object.entries(data.servers ?? {})) {
    const ref: ResourceRef = { plane: "echoink-vault", resourceId: `mcp/${id}` };
    connections[resourceRefToUri(ref)] = normalizeMcpConnection(raw, id);
  }
  return connections;
}

async function loadVaultResourceBindings(filePath: string): Promise<VaultResourceBinding[]> {
  const data = await readJsonFile<{ bindings?: RawBinding[] }>(filePath, { bindings: [] });
  return (data.bindings ?? []).map((binding) => {
    const ref = parseResourceUri(typeof binding.ref === "string" ? binding.ref : "");
    return {
      ref,
      uri: resourceRefToUri(ref),
      enabled: binding.enabled !== false,
      backendIds: Array.isArray(binding.backendIds) ? binding.backendIds.map(String).filter(Boolean) : undefined
    };
  });
}

async function loadVaultResourcePolicies(filePath: string): Promise<Record<string, VaultResourcePolicy>> {
  const data = await readJsonFile<{ policies?: Record<string, Partial<VaultResourcePolicy>> }>(filePath, { policies: {} });
  const policies: Record<string, VaultResourcePolicy> = {};
  for (const [uri, policy] of Object.entries(data.policies ?? {})) {
    const ref = parseResourceUri(uri);
    policies[resourceRefToUri(ref)] = {
      approval: policy.approval === "deny" || policy.approval === "never" ? policy.approval : "ask",
      network: policy.network === true,
      writeFiles: policy.writeFiles === true,
      maxCallsPerRun: positiveInteger(policy.maxCallsPerRun, 1),
      timeoutMs: positiveInteger(policy.timeoutMs, 30000)
    };
  }
  return policies;
}

interface RawMcpServer {
  transport?: unknown;
  url?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  headers?: unknown;
  env?: unknown;
}

interface RawBinding {
  ref?: unknown;
  scopes?: unknown;
  enabled?: unknown;
  backendIds?: unknown;
}

function normalizeMcpConnection(raw: RawMcpServer, id: string): VaultMcpConnection {
  const transport = raw.transport === "stdio" ? "stdio" : "http";
  const connection: VaultMcpConnection = {
    transport,
    headers: normalizeConnectionValues(raw.headers, `${id}.headers`),
    env: normalizeConnectionValues(raw.env, `${id}.env`)
  };
  if (typeof raw.url === "string") connection.url = raw.url;
  if (typeof raw.command === "string") connection.command = raw.command;
  if (Array.isArray(raw.args)) connection.args = raw.args.map(String);
  if (typeof raw.cwd === "string") connection.cwd = raw.cwd;
  if (transport === "http" && !connection.url) throw new Error(`MCP server ${id} requires url.`);
  if (transport === "stdio" && !connection.command) throw new Error(`MCP server ${id} requires command.`);
  return connection;
}

function normalizeConnectionValues(raw: unknown, label: string): Record<string, VaultConnectionValue> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const values: Record<string, VaultConnectionValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    values[key] = normalizeConnectionValue(key, value, label);
  }
  return values;
}

function normalizeConnectionValue(key: string, value: string, label: string): VaultConnectionValue {
  const secret = value.match(/^\$\{secret:([A-Z0-9_][A-Z0-9_-]*)\}$/i);
  if (secret) return { type: "secret-ref", name: secret[1] };
  if (isSecretLike(key, value)) {
    throw new Error(`Secrets must use \${secret:NAME} references in ${label}.${key}.`);
  }
  return { type: "literal", value };
}

function isSecretLike(key: string, value: string): boolean {
  const lowerKey = key.toLowerCase();
  const lowerValue = value.toLowerCase();
  return (
    lowerKey.includes("authorization") ||
    lowerKey.includes("token") ||
    lowerKey.includes("api-key") ||
    lowerKey.includes("cookie") ||
    lowerValue.startsWith("bearer ") ||
    /\b(ghp|gho|ghu|ghs|sk)-[a-z0-9_/-]{8,}/i.test(value)
  );
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const missing = null;
  const text = await readFile(filePath, "utf8").catch((error) => {
    if (isMissingFileSystemError(error)) return missing;
    throw error;
  });
  return text === missing ? fallback : JSON.parse(text) as T;
}

async function ensureDirectory(dir: string, created: string[], existing: string[]): Promise<void> {
  if (await pathExists(dir)) {
    existing.push(dir);
    return;
  }
  await mkdir(dir, { recursive: true });
  created.push(dir);
}

async function ensureFile(filePath: string, content: string, created: string[], existing: string[]): Promise<void> {
  if (await pathExists(filePath)) {
    existing.push(filePath);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  created.push(filePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    (error) => {
      if (isMissingFileSystemError(error)) return false;
      throw error;
    }
  );
}

export function isMissingFileSystemError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
