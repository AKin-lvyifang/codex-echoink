import { getDesktopCrypto } from "../platform/desktop-crypto";
import type {
  EchoInkMcpConnectionConfig,
  EchoInkMcpConnectionRecord,
  EchoInkMcpConnectionRecords,
  EchoInkMcpCredentialBinding,
  EchoInkMcpDiagnostic,
  EchoInkMcpDiagnosticCode,
  EchoInkMcpDiscoveredTool,
  EchoInkMcpToolPolicy,
  EchoInkMcpToolReadbackContract,
  EchoInkResource,
  EchoInkResourceSettings
} from "./types";

const { createHash } = getDesktopCrypto();

export type EchoInkMcpConnectionStatus =
  | "not-mcp"
  | "imported-only"
  | "missing-config"
  | "connectable"
  | "verified"
  | "failed";

const CREDENTIAL_REF_PATTERN = /^cred-[a-f0-9]{32}$/u;
const MCP_DIAGNOSTIC_CODES = new Set<EchoInkMcpDiagnosticCode>([
  "connection_failed",
  "authentication_failed",
  "schema_invalid",
  "disconnected",
  "timeout",
  "call_failed"
]);
const MAX_SAFE_STATUS_TEXT = 500;
const MAX_DISCOVERED_TOOLS = 2_048;
const MAX_SCHEMA_BYTES = 256 * 1024;

export function normalizeMcpConnectionRecords(value: unknown): EchoInkMcpConnectionRecords {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const records: EchoInkMcpConnectionRecords = {};
  for (const [resourceId, raw] of Object.entries(value)) {
    const record = normalizeMcpConnectionRecord(raw);
    if (record) records[resourceId] = record;
  }
  return records;
}

export function normalizeMcpConnectionRecord(value: unknown): EchoInkMcpConnectionRecord | null {
  const object = plainObject(value);
  if (!object) return null;
  const verifiedAt = nonNegativeNumber(object.verifiedAt);
  const lastError = safeStatusText(object.lastError);
  const diagnostic = normalizeMcpDiagnostic(object.diagnostic);
  const tools = normalizeCachedTools(object.tools);
  const toolPolicies = normalizeMcpToolPolicies(object.toolPolicies);
  const common = {
    trusted: typeof object.trusted === "boolean" ? object.trusted : false,
    toolPolicies,
    credential: normalizeMcpCredentialBinding(object.credential),
    tools,
    toolsFingerprint: safeFingerprint(object.toolsFingerprint),
    discoveredAt: nonNegativeNumber(object.discoveredAt),
    diagnostic,
    verifiedAt,
    lastError
  };
  if (object.transport === "stdio") {
    const command = stringValue(object.command).trim();
    if (!command) return null;
    return compactRecord({
      transport: "stdio",
      command,
      args: Array.isArray(object.args)
        ? object.args.map(String).filter((item) => item.length > 0)
        : [],
      env: plainStringRecord(object.env, { dropEmpty: true }),
      cwd: stringValue(object.cwd).trim() || undefined,
      ...common
    });
  }
  if (object.transport === "http") {
    const url = stringValue(object.url).trim();
    if (!url) return null;
    return compactRecord({
      transport: "http",
      url,
      headers: plainStringRecord(object.headers, { dropEmpty: true }),
      ...common
    });
  }
  return null;
}

export function resolveMcpConnectionRecord(
  resource: EchoInkResource,
  settings: Pick<EchoInkResourceSettings, "mcpConnections"> | null | undefined
): EchoInkMcpConnectionRecord | null {
  if (resource.kind !== "mcp-server") return null;
  const record = settings?.mcpConnections?.[resource.id];
  return record ?? null;
}

export function resolveMcpConnectionConfig(
  resource: EchoInkResource,
  settings: Pick<EchoInkResourceSettings, "mcpConnections"> | null | undefined
): EchoInkMcpConnectionConfig | null {
  const record = resolveMcpConnectionRecord(resource, settings);
  return record ? stripConnectionRecordStatus(record) : null;
}

export function mcpConnectionStatus(
  resource: EchoInkResource,
  settings: Pick<EchoInkResourceSettings, "mcpConnections"> | null | undefined
): EchoInkMcpConnectionStatus {
  if (resource.kind !== "mcp-server") return "not-mcp";
  const record = settings?.mcpConnections?.[resource.id];
  if (record?.diagnostic || record?.lastError) return "failed";
  if (record?.verifiedAt) return "verified";
  if (record) return "connectable";
  return "missing-config";
}

export function mcpConnectionStatusLabel(status: EchoInkMcpConnectionStatus, language: "zh-CN" | "en" = "zh-CN"): string {
  const zh: Record<EchoInkMcpConnectionStatus, string> = {
    "not-mcp": "",
    "imported-only": "已导入，待配置连接",
    "missing-config": "未配置连接",
    connectable: "已配置，尚未验证",
    verified: "连接已验证",
    failed: "上次连接失败"
  };
  const en: Record<EchoInkMcpConnectionStatus, string> = {
    "not-mcp": "",
    "imported-only": "Imported; connection needed",
    "missing-config": "Connection not configured",
    connectable: "Configured; not yet verified",
    verified: "Connection verified",
    failed: "Last connection failed"
  };
  return (language === "en" ? en : zh)[status];
}

export function mcpToolPolicy(
  record: Pick<EchoInkMcpConnectionRecord, "toolPolicies">,
  tool: Pick<EchoInkMcpDiscoveredTool, "name" | "readOnly">
): Readonly<EchoInkMcpToolPolicy> {
  const configured = record.toolPolicies[tool.name];
  if (configured) return configured;
  return Object.freeze({
    enabled: true,
    trusted: false
  });
}

export function mcpToolIsAdmitted(
  record: Pick<EchoInkMcpConnectionRecord, "trusted" | "toolPolicies">,
  tool: Pick<EchoInkMcpDiscoveredTool, "name" | "readOnly">
): boolean {
  const policy = mcpToolPolicy(record, tool);
  return record.trusted && policy.enabled && policy.trusted;
}

export function mcpToolContractsMatch(
  left: Pick<EchoInkMcpDiscoveredTool, "name" | "description" | "readOnly" | "destructive" | "inputSchema" | "readback">,
  right: Pick<EchoInkMcpDiscoveredTool, "name" | "description" | "readOnly" | "destructive" | "inputSchema" | "readback">
): boolean {
  return mcpToolContractFingerprint(left) === mcpToolContractFingerprint(right);
}

export function mcpToolContractFingerprint(
  tool: Pick<EchoInkMcpDiscoveredTool, "name" | "description" | "readOnly" | "destructive" | "inputSchema" | "readback">
): string {
  const contract = {
    name: tool.name,
    description: tool.description,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    inputSchema: tool.inputSchema,
    ...(tool.readback ? { readback: tool.readback } : {})
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableJson(contract)), "utf8")
    .digest("hex")}`;
}

export function mcpCredentialConfigured(record: EchoInkMcpConnectionRecord): boolean {
  return Boolean(record.credential?.credentialRef);
}

function stripConnectionRecordStatus(record: EchoInkMcpConnectionRecord): EchoInkMcpConnectionConfig {
  if (record.transport === "http") {
    return {
      transport: "http",
      url: record.url,
      headers: record.headers
    };
  }
  return {
    transport: "stdio",
    command: record.command,
    args: record.args,
    env: record.env,
    cwd: record.cwd
  };
}

function normalizeMcpCredentialBinding(value: unknown): EchoInkMcpCredentialBinding | undefined {
  const object = plainObject(value);
  if (!object) return undefined;
  const credentialRef = stringValue(object.credentialRef).trim();
  const targetName = stringValue(object.targetName).trim();
  const endpointRevision = positiveInteger(object.endpointRevision);
  const purpose = object.purpose === "mcp_header" || object.purpose === "mcp_env"
    ? object.purpose
    : null;
  if (!CREDENTIAL_REF_PATTERN.test(credentialRef) || !targetName || !endpointRevision || !purpose) {
    return undefined;
  }
  const prefix = stringValue(object.prefix);
  if (prefix.length > 64 || hasLineBreakOrNull(prefix)) return undefined;
  return {
    credentialRef,
    purpose,
    targetName,
    ...(prefix ? { prefix } : {}),
    endpointRevision
  };
}

function normalizeMcpToolPolicies(value: unknown): Record<string, EchoInkMcpToolPolicy> {
  const object = plainObject(value);
  if (!object) return {};
  const result: Record<string, EchoInkMcpToolPolicy> = {};
  for (const [toolName, raw] of Object.entries(object)) {
    const policy = plainObject(raw);
    if (!toolName.trim() || !policy) continue;
    result[toolName] = {
      enabled: policy.enabled !== false,
      trusted: policy.trusted === true
    };
  }
  return result;
}

function normalizeCachedTools(value: unknown): EchoInkMcpDiscoveredTool[] {
  if (!Array.isArray(value)) return [];
  const tools: EchoInkMcpDiscoveredTool[] = [];
  const names = new Set<string>();
  for (const raw of value.slice(0, MAX_DISCOVERED_TOOLS)) {
    const object = plainObject(raw);
    if (!object) continue;
    const name = stringValue(object.name).trim();
    const schema = normalizeObjectSchema(object.inputSchema);
    if (!name || names.has(name) || !schema) continue;
    names.add(name);
    const readback = normalizeReadbackContract(object.readback);
    tools.push({
      name,
      description: stringValue(object.description).slice(0, 4_000),
      readOnly: object.readOnly === true,
      destructive: object.destructive === true,
      inputSchema: schema,
      ...(readback ? { readback } : {})
    });
  }
  return tools;
}

function normalizeReadbackContract(value: unknown): EchoInkMcpToolReadbackContract | undefined {
  const object = plainObject(value);
  if (!object) return undefined;
  const toolName = stringValue(object.toolName).trim();
  const argumentMap = plainStringRecord(object.argumentMap, { dropEmpty: true });
  const assertions = Array.isArray(object.assertions)
    ? object.assertions.flatMap((raw) => {
      const assertion = plainObject(raw);
      const resultPath = stringValue(assertion?.resultPath).trim();
      const argumentKey = stringValue(assertion?.argumentKey).trim();
      return resultPath && argumentKey ? [{ resultPath, argumentKey }] : [];
    })
    : [];
  if (!toolName || !argumentMap || !assertions.length) return undefined;
  return { toolName, argumentMap, assertions };
}

function normalizeObjectSchema(value: unknown): Record<string, unknown> | null {
  const object = plainObject(value);
  if (!object || object.type !== "object") return null;
  try {
    const text = JSON.stringify(object);
    if (!text || Buffer.byteLength(text, "utf8") > MAX_SCHEMA_BYTES) return null;
    const cloned = JSON.parse(text) as unknown;
    return plainObject(cloned);
  } catch {
    return null;
  }
}

function normalizeMcpDiagnostic(value: unknown): EchoInkMcpDiagnostic | undefined {
  const object = plainObject(value);
  if (!object || !MCP_DIAGNOSTIC_CODES.has(object.code as EchoInkMcpDiagnosticCode)) return undefined;
  const message = safeStatusText(object.message);
  const occurredAt = nonNegativeNumber(object.occurredAt);
  if (!message || !occurredAt) return undefined;
  return {
    code: object.code as EchoInkMcpDiagnosticCode,
    message,
    occurredAt
  };
}

function safeFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)
    ? value
    : undefined;
}

function compactRecord<T extends EchoInkMcpConnectionRecord>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== "")
  ) as T;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeStatusText(value: unknown): string {
  return stringValue(value)
    .replaceAll("\u0000", " ")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, MAX_SAFE_STATUS_TEXT);
}

function hasLineBreakOrNull(value: string): boolean {
  return /[\r\n]/u.test(value) || value.includes("\u0000");
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function plainStringRecord(value: unknown, options: { dropEmpty: boolean }): Record<string, string> | undefined {
  const object = plainObject(value);
  if (!object) return undefined;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(object)) {
    if (typeof raw !== "string") continue;
    if (options.dropEmpty && !raw) continue;
    result[key] = raw;
  }
  return Object.keys(result).length ? result : undefined;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, raw]) => [key, stableJson(raw)]));
}
