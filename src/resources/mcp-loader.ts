import type { McpServerStatus } from "../types/app-server";
import type { EchoInkResource } from "./types";

export interface HermesMcpServerInfo {
  name: string;
  enabled?: boolean;
  toolsCount?: number;
  configPath?: string;
  transport?: string;
  status?: string;
}

export function mcpResourceFromCodexServer(server: McpServerStatus): EchoInkResource {
  return {
    id: stableResourceId("codex-import", "mcp-server", server.name),
    kind: "mcp-server",
    source: "codex-import",
    name: server.name,
    description: "Imported from Codex MCP configuration",
    enabled: true,
    scopes: ["chat", "knowledge", "editor-actions"],
    bridgeMode: "native-mcp",
    metadata: {
      authStatus: server.authStatus,
      toolsCount: Object.keys(server.tools ?? {}).length
    }
  };
}

export function mcpResourceFromHermesServer(server: HermesMcpServerInfo): EchoInkResource {
  return {
    id: stableResourceId("hermes-import", "mcp-server", server.name),
    kind: "mcp-server",
    source: "hermes-import",
    name: server.name,
    description: "Imported from Hermes MCP configuration",
    enabled: server.enabled !== false,
    scopes: ["chat", "knowledge", "editor-actions"],
    bridgeMode: "native-mcp",
    configPath: server.configPath,
    metadata: {
      toolsCount: server.toolsCount ?? 0,
      transport: server.transport,
      status: server.status
    }
  };
}

export function parseHermesMcpListOutput(output: string): HermesMcpServerInfo[] {
  if (/No MCP servers configured/i.test(output)) return [];
  const rows: HermesMcpServerInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const clean = stripBoxDrawing(line).trim();
    if (!clean || /^Name\s+/i.test(clean)) continue;
    if (/^[-─━┅┄┈┉┌└┏┗╞╘]+$/.test(clean)) continue;
    const cells = clean.includes("│")
      ? clean.split("│").map((part) => part.trim()).filter(Boolean)
      : clean.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    const normalizedCells = cells.length >= 2 ? cells : clean.split(/\s+/).map((part) => part.trim()).filter(Boolean);
    if (normalizedCells.length < 1) continue;
    const [name, transport = "", status = "", tools = "", configPath = ""] = normalizedCells;
    if (!name || /^add one with/i.test(name)) continue;
    const toolsCount = Number(String(tools).match(/\d+/)?.[0] ?? "0");
    rows.push({
      name,
      enabled: !/disabled|stopped|error/i.test(status),
      transport,
      status,
      toolsCount,
      configPath
    });
  }
  return rows;
}

function stableResourceId(source: string, kind: string, rawName: string): string {
  const name = String(rawName || kind)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${source}:${kind}:${name || "resource"}`;
}

function stripBoxDrawing(value: string): string {
  return value.replace(/[┏┓┗┛┡┩└┘┌┐┬┴┼┠┨┃│╇╞╡═━─]/g, " ");
}
