import type {
  EchoInkMcpConnectionConfig,
  EchoInkMcpConnectionRecord,
  EchoInkMcpConnectionRecords,
  EchoInkResource,
  EchoInkResourceSettings
} from "./types";

export type EchoInkMcpConnectionStatus =
  | "not-mcp"
  | "imported-only"
  | "missing-config"
  | "connectable"
  | "verified"
  | "failed";

export function normalizeMcpConnectionRecords(value: unknown): EchoInkMcpConnectionRecords {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const records: EchoInkMcpConnectionRecords = {};
  for (const [resourceId, raw] of Object.entries(value)) {
    const record = normalizeMcpConnectionRecord(raw);
    if (record) records[resourceId] = record;
  }
  return records;
}

export function resolveMcpConnectionConfig(
  resource: EchoInkResource,
  settings: Pick<EchoInkResourceSettings, "mcpConnections"> | null | undefined
): EchoInkMcpConnectionConfig | null {
  if (resource.kind !== "mcp-server") return null;
  const record = settings?.mcpConnections?.[resource.id];
  if (record) return stripConnectionRecordStatus(record);
  return legacyMcpConnectionConfig(resource);
}

export function mcpConnectionStatus(
  resource: EchoInkResource,
  settings: Pick<EchoInkResourceSettings, "mcpConnections"> | null | undefined
): EchoInkMcpConnectionStatus {
  if (resource.kind !== "mcp-server") return "not-mcp";
  const record = settings?.mcpConnections?.[resource.id];
  if (record?.lastError) return "failed";
  if (record?.verifiedAt) return "verified";
  if (record || legacyMcpConnectionConfig(resource)) return "connectable";
  return resource.source === "codex-import" || resource.source === "hermes-import" || resource.source === "opencode-import"
    ? "imported-only"
    : "missing-config";
}

export function mcpConnectionStatusLabel(status: EchoInkMcpConnectionStatus, language: "zh-CN" | "en" = "zh-CN"): string {
  const zh: Record<EchoInkMcpConnectionStatus, string> = {
    "not-mcp": "",
    "imported-only": "仅导入",
    "missing-config": "缺连接配置",
    connectable: "可连接",
    verified: "已验证",
    failed: "连接失败"
  };
  const en: Record<EchoInkMcpConnectionStatus, string> = {
    "not-mcp": "",
    "imported-only": "Imported only",
    "missing-config": "Missing config",
    connectable: "Connectable",
    verified: "Verified",
    failed: "Failed"
  };
  return (language === "en" ? en : zh)[status];
}

function normalizeMcpConnectionRecord(value: unknown): EchoInkMcpConnectionRecord | null {
  const object = plainObject(value);
  if (!object) return null;
  const verifiedAt = nonNegativeNumber(object.verifiedAt);
  const lastError = stringValue(object.lastError).trim();
  if (object.transport === "stdio") {
    const command = stringValue(object.command).trim();
    if (!command) return null;
    return {
      transport: "stdio",
      command,
      args: Array.isArray(object.args) ? object.args.map(String).filter((item) => item.length > 0) : [],
      env: plainStringRecord(object.env, { dropEmpty: true }),
      cwd: stringValue(object.cwd).trim() || undefined,
      ...(verifiedAt ? { verifiedAt } : {}),
      ...(lastError ? { lastError } : {})
    };
  }
  if (object.transport === "http") {
    const url = stringValue(object.url).trim();
    if (!url) return null;
    return {
      transport: "http",
      url,
      headers: plainStringRecord(object.headers, { dropEmpty: true }),
      ...(verifiedAt ? { verifiedAt } : {}),
      ...(lastError ? { lastError } : {})
    };
  }
  return null;
}

function legacyMcpConnectionConfig(resource: EchoInkResource): EchoInkMcpConnectionConfig | null {
  const raw = plainObject(resource.metadata?.mcp);
  if (!raw) return null;
  const normalized = normalizeMcpConnectionRecord(raw);
  return normalized ? stripConnectionRecordStatus(normalized) : null;
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

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
