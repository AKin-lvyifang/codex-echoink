import { enabledResourcesForScope } from "./registry";
import { mcpConnectionStatus, mcpConnectionStatusLabel, resolveMcpConnectionConfig } from "./mcp-connections";
import type {
  EchoInkCallableMcpTool,
  EchoInkCallableMcpToolCatalog,
  EchoInkMcpConnectionRecords,
  EchoInkResource,
  EchoInkResourceScope
} from "./types";

export interface BuildCallableMcpToolCatalogInput {
  resources: EchoInkResource[];
  scope: EchoInkResourceScope;
  enabledByScope?: Partial<Record<EchoInkResourceScope, Record<string, boolean>>>;
  connections?: EchoInkMcpConnectionRecords;
  listTools(resource: EchoInkResource): Promise<unknown[] | { tools?: unknown[] }>;
}

export async function buildCallableMcpToolCatalog(input: BuildCallableMcpToolCatalogInput): Promise<EchoInkCallableMcpToolCatalog> {
  const enabledMcpResources = enabledResourcesForScope(input.resources, input.scope, input.enabledByScope)
    .filter((resource) => resource.kind === "mcp-server");
  const warnings: string[] = [];
  const tools: EchoInkCallableMcpTool[] = [];
  const settings = { mcpConnections: input.connections ?? {} };
  for (const resource of enabledMcpResources) {
    const config = resolveMcpConnectionConfig(resource, settings);
    if (!config) {
      const status = mcpConnectionStatus(resource, settings);
      warnings.push(`${resource.name}：${mcpConnectionStatusLabel(status)}，缺少 EchoInk broker 连接配置，暂不可调用。`);
      continue;
    }
    const listed = await input.listTools(resource);
    for (const tool of normalizeListedTools(listed)) {
      const toolName = typeof tool.name === "string" ? tool.name.trim() : "";
      if (!toolName) continue;
      tools.push({
        name: `${normalizeToolNamePart(resource.name)}.${normalizeToolNamePart(toolName)}`,
        resourceId: resource.id,
        resourceName: resource.name,
        toolName,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema
      });
    }
  }
  return { tools, warnings };
}

function normalizeListedTools(value: unknown[] | { tools?: unknown[] }): Array<Record<string, unknown>> {
  const rawTools = Array.isArray(value) ? value : Array.isArray(value.tools) ? value.tools : [];
  return rawTools.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function normalizeToolNamePart(value: string): string {
  return value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tool";
}
