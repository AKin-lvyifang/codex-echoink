import { getDesktopCrypto } from "../platform/desktop-crypto";
import { enabledResources } from "./registry";
import {
  mcpConnectionStatus,
  mcpConnectionStatusLabel,
  mcpToolContractsMatch,
  mcpToolIsAdmitted,
  resolveMcpConnectionConfig,
  resolveMcpConnectionRecord
} from "./mcp-connections";
import type {
  EchoInkCallableMcpTool,
  EchoInkCallableMcpToolCatalog,
  EchoInkMcpConnectionRecords,
  EchoInkMcpDiscoveredTool,
  EchoInkMcpToolReadbackContract,
  EchoInkResource
} from "./types";

const { createHash } = getDesktopCrypto();

export interface BuildCallableMcpToolCatalogInput {
  resources: EchoInkResource[];
  connections?: EchoInkMcpConnectionRecords;
  listTools(resource: EchoInkResource): Promise<unknown[] | { tools?: unknown[] }>;
}

export interface InspectMcpToolListResult {
  readonly tools: readonly EchoInkMcpDiscoveredTool[];
  readonly fingerprint: string;
  readonly warnings: readonly string[];
}

export async function buildCallableMcpToolCatalog(input: BuildCallableMcpToolCatalogInput): Promise<EchoInkCallableMcpToolCatalog> {
  const enabledMcpResources = enabledResources(input.resources)
    .filter((resource) => resource.kind === "mcp-server");
  const warnings: string[] = [];
  const tools: EchoInkCallableMcpTool[] = [];
  const settings = { mcpConnections: input.connections ?? {} };
  for (const resource of enabledMcpResources) {
    const config = resolveMcpConnectionConfig(resource, settings);
    const record = resolveMcpConnectionRecord(resource, settings);
    if (!config || !record) {
      const status = mcpConnectionStatus(resource, settings);
      warnings.push(`${resource.name}：${mcpConnectionStatusLabel(status)}，缺少 EchoInk broker 连接配置，暂不可调用。`);
      continue;
    }
    if (!record.trusted) {
      warnings.push(`${resource.name}：Server 尚未信任，未向当前 Pi AgentSession 注册工具。`);
      continue;
    }
    let inspected: InspectMcpToolListResult;
    try {
      inspected = inspectMcpToolList(await input.listTools(resource));
    } catch (error) {
      warnings.push(`${resource.name}：${safeDiscoveryFailure(error)}`);
      continue;
    }
    warnings.push(...inspected.warnings.map((warning) => `${resource.name}：${warning}`));
    for (const tool of inspected.tools) {
      if (!mcpToolIsAdmitted(record, tool)) continue;
      const cachedTool = record.tools.find((candidate) => candidate.name === tool.name);
      if (!cachedTool) {
        warnings.push(`${resource.name}：Tool ${tool.name} 尚未经过刷新与信任，暂不注册。`);
        continue;
      } else if (!mcpToolContractsMatch(cachedTool, tool)) {
        warnings.push(`${resource.name}：Tool ${tool.name} 的 Schema 或安全合同已变化，请刷新后重新信任。`);
        continue;
      }
      if (tool.readback) {
        const readbackTool = inspected.tools.find((candidate) => candidate.name === tool.readback?.toolName);
        const cachedReadbackTool = record.tools.find((candidate) => candidate.name === tool.readback?.toolName);
        if (
          !readbackTool
          || !mcpToolIsAdmitted(record, readbackTool)
          || (cachedReadbackTool && !mcpToolContractsMatch(cachedReadbackTool, readbackTool))
          || !cachedReadbackTool
        ) {
          warnings.push(`${resource.name}：Tool ${tool.name} 的 Readback ${tool.readback.toolName} 尚未启用并信任，暂不注册副作用 Tool。`);
          continue;
        }
      }
      tools.push({
        name: `${normalizeToolNamePart(resource.name)}.${normalizeToolNamePart(tool.name)}`,
        resourceId: resource.id,
        resourceName: resource.name,
        toolName: tool.name,
        description: tool.description,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        inputSchema: tool.inputSchema,
        ...(tool.readback ? { readback: tool.readback } : {})
      });
    }
  }
  return { tools, warnings };
}

export function inspectMcpToolList(value: unknown[] | { tools?: unknown[] }): InspectMcpToolListResult {
  const rawTools = Array.isArray(value) ? value : Array.isArray(value.tools) ? value.tools : [];
  const tools: EchoInkMcpDiscoveredTool[] = [];
  const warnings: string[] = [];
  const names = new Set<string>();
  for (const [index, raw] of rawTools.entries()) {
    const tool = plainRecord(raw);
    if (!tool) {
      warnings.push(`第 ${index + 1} 个 Tool 不是有效对象，已拒绝。`);
      continue;
    }
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name || name.length > 256) {
      warnings.push(`第 ${index + 1} 个 Tool 缺少有效名称，已拒绝。`);
      continue;
    }
    if (names.has(name)) {
      warnings.push(`Tool ${name} 重名，已拒绝重复项。`);
      continue;
    }
    const inputSchema = normalizeInputSchema(tool.inputSchema);
    if (!inputSchema) {
      warnings.push(`Tool ${name} 的 inputSchema 非法，已拒绝注册。`);
      continue;
    }
    names.add(name);
    const readback = readbackFromTool(tool);
    tools.push({
      name,
      description: typeof tool.description === "string"
        ? tool.description.slice(0, 4_000)
        : "",
      readOnly: annotationBoolean(tool, "readOnlyHint"),
      destructive: annotationBoolean(tool, "destructiveHint"),
      inputSchema,
      ...(readback ? { readback } : {})
    });
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const validated = tools.map((tool) => {
    if (!tool.readback) return tool;
    const readbackTool = byName.get(tool.readback.toolName);
    if (!readbackTool || !readbackTool.readOnly) {
      warnings.push(`Tool ${tool.name} 的 Readback ${tool.readback.toolName} 不存在或未声明只读，已禁用 Readback。`);
      const { readback: _readback, ...withoutReadback } = tool;
      return withoutReadback;
    }
    return tool;
  });
  const fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(validated), "utf8")
    .digest("hex")}`;
  return Object.freeze({
    tools: Object.freeze(validated.map((tool) => Object.freeze(tool))),
    fingerprint,
    warnings: Object.freeze(warnings)
  });
}

function annotationBoolean(tool: Record<string, unknown>, key: string): boolean {
  const annotations = plainRecord(tool.annotations);
  return annotations?.[key] === true;
}

function readbackFromTool(tool: Record<string, unknown>): EchoInkMcpToolReadbackContract | undefined {
  const meta = plainRecord(tool._meta);
  const raw = plainRecord(meta?.["echoink/readback"]);
  if (!raw) return undefined;
  const toolName = typeof raw.toolName === "string" ? raw.toolName.trim() : "";
  const argumentMap = plainStringMap(raw.argumentMap);
  const assertions = Array.isArray(raw.assertions)
    ? raw.assertions.flatMap((item) => {
      const assertion = plainRecord(item);
      const resultPath = typeof assertion?.resultPath === "string" ? assertion.resultPath.trim() : "";
      const argumentKey = typeof assertion?.argumentKey === "string" ? assertion.argumentKey.trim() : "";
      return resultPath && argumentKey ? [{ resultPath, argumentKey }] : [];
    })
    : [];
  if (!toolName || !Object.keys(argumentMap).length || !assertions.length) return undefined;
  return Object.freeze({
    toolName,
    argumentMap: Object.freeze(argumentMap),
    assertions: Object.freeze(assertions.map((item) => Object.freeze(item))) as EchoInkMcpToolReadbackContract["assertions"]
  });
}

function normalizeInputSchema(value: unknown): Record<string, unknown> | null {
  const schema = plainRecord(value);
  if (!schema || schema.type !== "object") return null;
  try {
    const serialized = JSON.stringify(schema);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > 256 * 1024) return null;
    const parsed = JSON.parse(serialized) as unknown;
    return plainRecord(parsed);
  } catch {
    return null;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function plainStringMap(value: unknown): Record<string, string> {
  const record = plainRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).flatMap(([key, raw]) =>
    key.trim() && typeof raw === "string" && raw.trim()
      ? [[key.trim(), raw.trim()]]
      : []));
}

function normalizeToolNamePart(value: string): string {
  return value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tool";
}

function safeDiscoveryFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = message
    .replaceAll("\u0000", " ")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 300);
  return safe || "tools/list 失败。";
}
