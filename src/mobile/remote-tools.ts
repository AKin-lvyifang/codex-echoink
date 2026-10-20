import type { EchoInkMcpDiscoveredTool, EchoInkMcpToolPolicy, EchoInkMcpToolReadbackContract } from "../resources/types";
import { sha256Hex } from "../utils/sha256";
import type { MobileRequest } from "./transport";

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : record(value)
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
export const mobileMcpToolName = (resourceId: string, toolName: string): string => `mcp_${sha256Hex(JSON.stringify([resourceId, toolName])).slice(0, 24)}`;
export const mobileMcpContractFingerprint = (tool: EchoInkMcpDiscoveredTool): string => `sha256:${sha256Hex(JSON.stringify(stable({ name: tool.name,
  description: tool.description, readOnly: tool.readOnly, destructive: tool.destructive, inputSchema: tool.inputSchema, ...(tool.readback ? { readback: tool.readback } : {}) })))}`;
export const mobileMcpAdmitted = (config: { trusted: boolean; toolPolicies: Record<string, EchoInkMcpToolPolicy> }, name: string): boolean =>
  config.trusted === true && config.toolPolicies[name]?.enabled === true && config.toolPolicies[name]?.trusted === true;
export function mobileMcpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("请填写有效的 HTTP MCP 地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("请使用 HTTP 或 HTTPS 地址，认证信息填写在请求头中。");
  return url.href;
}
export function mobileMcpHeaders(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/u.test(key) || typeof item !== "string" || (/[\r\n]/u.test(item) || item.includes(String.fromCharCode(0)))) throw new Error("请求头格式无效。");
    if (["host", "content-length", "mcp-session-id", "mcp-protocol-version", "accept", "content-type"].includes(key.toLowerCase())) throw new Error("此请求头由 MCP 连接自动管理。");
    result[key] = item;
  }
  return result;
}
/** Same conservative annotations and readback contract as the desktop catalog, without Node. */
export function inspectMobileMcpTools(raw: unknown): EchoInkMcpDiscoveredTool[] {
  if (!Array.isArray(raw) || raw.length > 2048) throw new Error("MCP 工具列表格式无效。");
  const names = new Set<string>();
  const tools = raw.map(value => {
    const item = record(value), schema = record(item?.inputSchema), name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!item || !name || name.length > 256 || names.has(name) || !schema || schema.type !== "object" || new TextEncoder().encode(JSON.stringify(schema)).length > 256 * 1024) throw new Error("MCP 工具名称或输入格式无效。");
    names.add(name);
    const annotations = record(item.annotations), meta = record(record(item._meta)?.["echoink/readback"]);
    let readback: EchoInkMcpToolReadbackContract | undefined;
    if (meta && typeof meta.toolName === "string" && meta.toolName.trim()) {
      const argumentMap = Object.fromEntries(Object.entries(record(meta.argumentMap) ?? {}).filter(([key, value]) => key.trim() && typeof value === "string" && value.trim()).map(([key, value]) => [key.trim(), (value as string).trim()]));
      const assertions = Array.isArray(meta.assertions) ? meta.assertions.flatMap(value => {
        const row = record(value); return typeof row?.resultPath === "string" && row.resultPath.trim() && typeof row.argumentKey === "string" && row.argumentKey.trim()
          ? [{ resultPath: row.resultPath.trim(), argumentKey: row.argumentKey.trim() }] : [];
      }) : [];
      if (Object.keys(argumentMap).length && assertions.length) readback = { toolName: meta.toolName.trim(), argumentMap, assertions };
    }
    return { name, description: typeof item.description === "string" ? item.description.slice(0, 4000) : "", readOnly: annotations?.readOnlyHint === true,
      destructive: annotations?.destructiveHint === true, inputSchema: structuredClone(schema), ...(readback ? { readback } : {}) };
  });
  return tools.map(tool => {
    if (!tool.readback || tools.some(candidate => candidate.name === tool.readback?.toolName && candidate.readOnly)) return tool;
    const { readback: _readback, ...without } = tool; return without;
  });
}
export class MobileMcpError extends Error {
  constructor(readonly code: "cancelled" | "timeout" | "network" | "authentication" | "invalid_response" | "session_expired" | "tool_failed", message: string) { super(message); }
}
export interface MobileMcpEndpoint { url: string; headers?: Record<string, string> }
/** One connection belongs to one discovery/call. No global session, retry, or background reconnect. */
export class MobileHttpMcpClient {
  private session = "";
  private protocol = "2025-03-26";
  private sequence = 0;
  private readonly endpoint: MobileMcpEndpoint;
  constructor(endpoint: MobileMcpEndpoint, private request: MobileRequest, private timeoutMs = 20_000) {
    this.endpoint = { url: mobileMcpUrl(endpoint.url), headers: mobileMcpHeaders(endpoint.headers ?? {}) };
  }
  async discover(signal?: AbortSignal, assertAllowed: () => void = () => {}): Promise<EchoInkMcpDiscoveredTool[]> {
    const initialized = record(await this.rpc("initialize", { protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: "EchoInk-mobile", version: "1" } }, signal, assertAllowed));
    if (!initialized || typeof initialized.protocolVersion !== "string" || !record(initialized.capabilities)) throw new MobileMcpError("invalid_response", "MCP 初始化响应无效。");
    if (!["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(initialized.protocolVersion)) throw new MobileMcpError("invalid_response", "MCP 协议版本暂不支持。");
    this.protocol = initialized.protocolVersion;
    await this.rpc("notifications/initialized", {}, signal, assertAllowed, true);
    const tools: unknown[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = record(await this.rpc("tools/list", cursor ? { cursor } : {}, signal, assertAllowed));
      if (!Array.isArray(page?.tools)) throw new MobileMcpError("invalid_response", "MCP 工具列表响应无效。");
      tools.push(...(page.tools as unknown[]));
      if (tools.length > 2048 || cursors.size > 128) throw new MobileMcpError("invalid_response", "MCP 工具分页超出限制。");
      if (page.nextCursor !== undefined && typeof page.nextCursor !== "string") throw new MobileMcpError("invalid_response", "MCP 工具分页响应无效。");
      cursor = page.nextCursor;
      if (cursor) { if (cursors.has(cursor)) throw new MobileMcpError("invalid_response", "MCP 工具分页未推进。"); cursors.add(cursor); }
    } while (cursor);
    return inspectMobileMcpTools(this.sanitize(tools));
  }
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, assertAllowed: () => void = () => {}): Promise<Record<string, unknown>> {
    const result = record(await this.rpc("tools/call", { name, arguments: args }, signal, assertAllowed));
    if (!result || (!Array.isArray(result.content) && !record(result.structuredContent))) throw new MobileMcpError("invalid_response", "MCP 工具未返回有效结果，写入状态需要核对。");
    if (result.isError === true) throw new MobileMcpError("tool_failed", "MCP 工具执行失败，写入状态需要核对。");
    // Credential values echoed by a server cannot reach model/UI or persistent task messages.
    return this.sanitize(result);
  }
  private sanitize<T>(value: T): T {
    const headers = Object.values(this.endpoint.headers ?? {});
    const secrets = [...headers, ...headers.flatMap(header => /^(?:Bearer|Basic)\s+(.+)$/iu.exec(header)?.slice(1) ?? []), ...Array.from(new URL(this.endpoint.url).searchParams.values())]
      .filter(Boolean).sort((a, b) => b.length - a.length);
    const clean = (text: string): string => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
    // Work on decoded values and keys. Replacing raw secrets in serialized JSON
    // misses quotes/backslashes and can also corrupt the JSON representation.
    const visit = (item: unknown): unknown => typeof item === "string" ? clean(item) : Array.isArray(item) ? item.map(visit)
      : record(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [clean(key), visit(child)])) : item;
    return visit(value) as T;
  }
  private async rpc(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, assertAllowed: () => void, notification = false): Promise<unknown> {
    const check = () => { if (signal?.aborted) throw new MobileMcpError("cancelled", "MCP 操作已停止。"); assertAllowed(); };
    check();
    const id = ++this.sequence;
    const headers = { ...this.endpoint.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.protocol,
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}) };
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const cancel = () => {
      // requestUrl has no physical abort. MCP cancellation stops server work where supported.
      void this.request({ url: this.endpoint.url, method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Client stopped" } }), throw: false }).catch(() => {});
    };
    try {
      const interrupted = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { cancel(); reject(new MobileMcpError("timeout", "MCP 连接超时，未自动重试。")); }, this.timeoutMs);
        abort = () => { cancel(); reject(new MobileMcpError("cancelled", "MCP 操作已停止。")); };
        signal?.addEventListener("abort", abort, { once: true });
      });
      check();
      const response = await Promise.race([this.request({ url: this.endpoint.url, method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }), throw: false }), interrupted]);
      check();
      if ([401, 403].includes(response.status)) throw new MobileMcpError("authentication", "MCP 认证失败，请检查请求头。" );
      if ([404, 410].includes(response.status) && this.session) { this.session = ""; throw new MobileMcpError("session_expired", "MCP 连接已失效，请重新连接；未重放调用。" ); }
      if (response.status < 200 || response.status >= 300) throw new MobileMcpError("network", "MCP 服务连接失败。" );
      const extra = response as typeof response & { headers?: Record<string, string>; text?: string };
      const session = Object.entries(extra.headers ?? {}).find(([key]) => key.toLowerCase() === "mcp-session-id")?.[1];
      if (session) { if ((/[\r\n]/u.test(session) || session.includes(String.fromCharCode(0)))) throw new MobileMcpError("invalid_response", "MCP 会话响应无效。" ); this.session = session; }
      if (notification) return undefined;
      let envelope: Record<string, unknown> | null = null;
      try { envelope = record(response.json); } catch { /* An SSE response has no JSON getter. */ }
      if (!envelope && typeof extra.text === "string") {
        for (const event of extra.text.split(/\r?\n\r?\n/u)) {
          const data = event.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try { const item = record(JSON.parse(data)); if (item?.id === id) envelope = item; } catch { /* Ignore unrelated SSE events. */ }
        }
      }
      if (!envelope || envelope.jsonrpc !== "2.0" || envelope.id !== id || envelope.error || !("result" in envelope)) throw new MobileMcpError("invalid_response", "MCP 协议响应无效。" );
      return envelope.result;
    } catch (error) {
      if (error instanceof MobileMcpError || signal?.aborted) throw signal?.aborted ? new MobileMcpError("cancelled", "MCP 操作已停止。") : error;
      // Keep live permission failures; never expose upstream network errors or credentials.
      assertAllowed();
      throw new MobileMcpError("network", "MCP 服务连接失败。" );
    } finally { if (timer !== undefined) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
  }
}
