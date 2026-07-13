import type { AgentBackendCapabilities } from "../agent/types";
import type { PreparedAgentResources } from "../agent/runtime";
import type { ResourceRef, ResourceSelectionSnapshot } from "../harness/contracts/run";
import type { CodexPluginInfo, CodexSkill, McpServerStatus } from "../types/app-server";
import type { WorkspaceResourceToggles } from "../settings/settings";
import { buildBuiltinToolBundleResources } from "./tool-bundles";
import { defaultMcpBrokerSettings, isMcpBrokerConnectable } from "./mcp-broker";
import { mcpResourceFromCodexServer, mcpResourceFromHermesServer, type HermesMcpServerInfo } from "./mcp-loader";
import { skillResourceFromCodexSkill, skillResourceFromHermesSkill, type HermesSkillInfo } from "./skill-loader";
import type { EchoInkMcpConnectionRecords, EchoInkResource, EchoInkResourceScope, EchoInkResourceSettings, EchoInkResourceSource } from "./types";

export interface BuildEchoInkResourceCatalogInput {
  codex?: {
    plugins?: CodexPluginInfo[];
    skills?: CodexSkill[];
    mcpServers?: McpServerStatus[];
  };
  hermes?: {
    skills?: HermesSkillInfo[];
    mcpServers?: HermesMcpServerInfo[];
  };
  manual?: EchoInkResource[];
  settings?: Partial<EchoInkResourceSettings>;
}

export interface PrepareAgentResourcesInput {
  scope: EchoInkResourceScope;
  backendCapabilities: AgentBackendCapabilities;
  enabledByScope?: Partial<Record<EchoInkResourceScope, Record<string, boolean>>>;
  mcpConnections?: EchoInkMcpConnectionRecords;
}

export function buildEchoInkResourceCatalog(input: BuildEchoInkResourceCatalogInput = {}): EchoInkResource[] {
  const resources: EchoInkResource[] = [
    ...buildBuiltinToolBundleResources(),
    ...(input.codex?.skills ?? []).map(skillResourceFromCodexSkill),
    ...(input.codex?.mcpServers ?? []).map(mcpResourceFromCodexServer),
    ...(input.codex?.plugins ?? []).map(pluginResourceFromCodexPlugin),
    ...(input.hermes?.skills ?? []).map(skillResourceFromHermesSkill),
    ...(input.hermes?.mcpServers ?? []).map(mcpResourceFromHermesServer),
    ...(input.settings?.catalog ?? []),
    ...(input.manual ?? [])
  ];
  return uniqueResources(resources);
}

export function prepareAgentResources(catalog: EchoInkResource[], input: PrepareAgentResourcesInput): PreparedAgentResources {
  const enabledResources = enabledResourcesForScope(catalog, input.scope, input.enabledByScope);
  const promptSkills = enabledResources.filter((resource) => resource.kind === "skill" && resource.bridgeMode === "prompt-only");
  const promptPrefix = promptSkills.length
    ? [
      "本轮 EchoInk 已启用以下 Skill 说明。你必须按这些说明工作，但资源开关只作用于当前 EchoInk 插件，不代表修改任何 Agent 全局配置。",
      ...promptSkills.map((skill) => `- /${skill.name}: ${skill.description || skill.contentPath || "无描述"}`)
    ].join("\n")
    : "";
  const mcpResources = enabledResources.filter((resource) => resource.kind === "mcp-server");
  const warnings: string[] = [];
  let mcpConfig: Record<string, unknown> | null = null;
  let toolBridge: PreparedAgentResources["toolBridge"] = null;
  if (mcpResources.length) {
    const brokerReadyResources = mcpResources.filter((resource) => isMcpBrokerConnectable(resource, input.mcpConnections));
    const importedOnlyResources = mcpResources.filter((resource) => !isMcpBrokerConnectable(resource, input.mcpConnections));
    if (input.backendCapabilities.nativeMcpPassThrough) {
      mcpConfig = Object.fromEntries(mcpResources.map((resource) => [resource.name, { source: resource.source, configPath: resource.configPath ?? "" }]));
      toolBridge = {
        mode: "native-mcp",
        resourceIds: mcpResources.map((resource) => resource.id),
        ready: true,
        note: "当前后端支持 native MCP passthrough，EchoInk 会按本轮资源开关生成临时配置。"
      };
    } else if (input.backendCapabilities.structuredToolCalls && brokerReadyResources.length) {
      if (importedOnlyResources.length) warnings.push("部分 MCP 已导入但缺少 EchoInk broker 连接配置，暂不可直接调用。");
      toolBridge = {
        mode: "structured-tools",
        resourceIds: brokerReadyResources.map((resource) => resource.id),
        ready: true,
        note: "当前后端支持结构化工具请求；EchoInk broker 将负责审批、调用和日志。"
      };
    } else if (input.backendCapabilities.structuredToolCalls) {
      warnings.push("MCP 已导入，但缺少 EchoInk broker 连接配置；暂不可直接调用。");
      toolBridge = {
        mode: "structured-tools",
        resourceIds: mcpResources.map((resource) => resource.id),
        ready: false,
        note: "MCP 资源需要 EchoInk 连接配置后才能由 EchoInk broker 调用。"
      };
    } else if (brokerReadyResources.length) {
      if (importedOnlyResources.length) warnings.push("部分 MCP 已导入但缺少 EchoInk broker 连接配置，暂不可直接调用。");
      toolBridge = {
        mode: "echoink-tool-loop",
        resourceIds: brokerReadyResources.map((resource) => resource.id),
        ready: true,
        note: "当前后端没有原生结构化工具；EchoInk 会使用 broker-mediated tool loop 负责审批、调用和日志。"
      };
    } else {
      warnings.push("MCP 已导入，但缺少 EchoInk broker 连接配置；暂不可直接调用。");
      toolBridge = {
        mode: "disabled",
        resourceIds: mcpResources.map((resource) => resource.id),
        ready: false,
        note: "MCP 资源需要 EchoInk 连接配置后才能由 EchoInk broker 调用。"
      };
    }
  }
  return {
    promptPrefix,
    enabledResources,
    warnings,
    mcpConfig,
    toolBridge
  };
}

export function resourceSelectionFromPreparedResources(
  resources: Pick<PreparedAgentResources, "enabledResources" | "warnings">,
  backendId: string,
  resolvedAt = Date.now()
): ResourceSelectionSnapshot {
  const selected: ResourceRef[] = [];
  const warnings = [...resources.warnings];
  for (const resource of resources.enabledResources) {
    const ref = resourceRefFromEchoInkResource(resource, backendId);
    if (ref) {
      selected.push(ref);
      continue;
    }
    const nativeBackendId = nativeBackendIdForResourceSource(resource.source);
    if (nativeBackendId && nativeBackendId !== backendId) {
      warnings.push(`资源 ${resource.name || resource.id} 属于 ${nativeBackendId} 原生资源，当前后端 ${backendId} 不可直接使用。`);
    }
  }
  return { selected, resolvedAt, warnings };
}

export function enabledResourcesForScope(
  catalog: EchoInkResource[],
  scope: EchoInkResourceScope,
  enabledByScope?: Partial<Record<EchoInkResourceScope, Record<string, boolean>>>
): EchoInkResource[] {
  const overrides = enabledByScope?.[scope] ?? {};
  return catalog.filter((resource) => resourceEnabledForScope(resource, scope, overrides));
}

export function resourceEnabledForScope(resource: EchoInkResource, scope: EchoInkResourceScope, overrides?: Record<string, boolean>): boolean {
  if (!resource.scopes.includes(scope)) return false;
  const override = overrides?.[resource.id];
  return typeof override === "boolean" ? override : resource.enabled;
}

export function skillResourcesForScope(
  catalog: EchoInkResource[],
  scope: EchoInkResourceScope,
  enabledByScope?: Partial<Record<EchoInkResourceScope, Record<string, boolean>>>
): EchoInkResource[] {
  return enabledResourcesForScope(catalog, scope, enabledByScope)
    .filter((resource) => resource.kind === "skill")
    .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase(), "en") || left.id.localeCompare(right.id));
}

export function filterSkillResources(skills: EchoInkResource[], query: string): EchoInkResource[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  return skills
    .filter((skill) => {
      if (!q) return true;
      return skill.name.toLowerCase().includes(q) || (skill.description || "").toLowerCase().includes(q) || (skill.contentPath || "").toLowerCase().includes(q);
    })
    .filter((skill) => {
      const key = `${skill.source}:${skill.name}`.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function workspaceResourcesFromEchoInkResources(
  catalog: EchoInkResource[],
  scope: EchoInkResourceScope,
  enabledByScope?: Partial<Record<EchoInkResourceScope, Record<string, boolean>>>
): WorkspaceResourceToggles {
  const toggles: WorkspaceResourceToggles = { plugins: {}, mcpServers: {}, skills: {} };
  for (const resource of catalog) {
    if (resource.source !== "codex-import") continue;
    if (!resource.scopes.includes(scope)) continue;
    const enabled = resourceEnabledForScope(resource, scope, enabledByScope?.[scope] ?? {});
    if (resource.kind === "skill") toggles.skills[resource.contentPath || resource.name] = enabled;
    if (resource.kind === "mcp-server") toggles.mcpServers[resource.name] = enabled;
    if (resource.kind === "tool-bundle") {
      const pluginId = typeof resource.metadata?.pluginId === "string" ? resource.metadata.pluginId : resource.name;
      toggles.plugins[pluginId] = enabled;
    }
  }
  return toggles;
}

export const codexResourceOverridesFromEchoInkResources = workspaceResourcesFromEchoInkResources;

export function hasEnabledMcpResources(
  catalog: EchoInkResource[],
  scope: EchoInkResourceScope,
  enabledByScope?: Partial<Record<EchoInkResourceScope, Record<string, boolean>>>
): boolean {
  return enabledResourcesForScope(catalog, scope, enabledByScope).some((resource) => resource.kind === "mcp-server");
}

export function defaultResourceSettings(): EchoInkResourceSettings {
  return {
    catalog: [],
    enabledByScope: {
      chat: {},
      knowledge: {},
      "editor-actions": {}
    },
    importedFrom: {},
    mcpBroker: defaultMcpBrokerSettings(),
    mcpConnections: {},
    lastScannedAt: 0,
    lastError: ""
  };
}

function pluginResourceFromCodexPlugin(plugin: CodexPluginInfo): EchoInkResource {
  return {
    id: stableResourceId("codex-import", "tool-bundle", plugin.id || plugin.name),
    kind: "tool-bundle",
    source: "codex-import",
    name: plugin.displayName || plugin.name || plugin.id,
    description: plugin.description || "",
    enabled: plugin.enabled !== false,
    scopes: ["chat", "knowledge", "editor-actions"],
    bridgeMode: "plugin-tool",
    metadata: {
      pluginId: plugin.id,
      marketplace: plugin.marketplace,
      installed: plugin.installed
    }
  };
}

function uniqueResources(resources: EchoInkResource[]): EchoInkResource[] {
  const seen = new Map<string, EchoInkResource>();
  for (const resource of resources) {
    if (!resource.id) continue;
    seen.set(resource.id, resource);
  }
  return Array.from(seen.values());
}

function stableResourceId(source: string, kind: string, rawName: string): string {
  const name = String(rawName || kind)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${source}:${kind}:${name || "resource"}`;
}

function resourceRefFromEchoInkResource(resource: EchoInkResource, backendId: string): ResourceRef | null {
  if (resource.source === "echoink-local") {
    if (resource.kind === "tool-bundle") return null;
    return { plane: "echoink-vault", resourceId: resource.contentPath || resource.name || resource.id };
  }
  if (resource.bridgeMode === "prompt-only") return { plane: "imported-copy", resourceId: resource.id };
  const nativeBackendId = nativeBackendIdForResourceSource(resource.source);
  if (nativeBackendId && nativeBackendId === backendId) {
    return { plane: "agent-native", backendId: nativeBackendId, resourceId: resource.name || resource.id };
  }
  if (resource.source === "manual") return { plane: "imported-copy", resourceId: resource.id };
  return null;
}

function nativeBackendIdForResourceSource(source: EchoInkResourceSource): string {
  if (source === "codex-import") return "codex-cli";
  if (source === "opencode-import") return "opencode";
  if (source === "hermes-import") return "hermes";
  return "";
}
