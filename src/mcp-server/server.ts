import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getDesktopHttp, getDesktopNet } from "../platform/desktop-network";
import { getDesktopBuffer } from "../platform/desktop-runtime";
import { getDesktopCrypto } from "../platform/desktop-crypto";
import { ECHOINK_MCP_INSTRUCTIONS, echoInkMcpSetupText } from "./instructions";
import { EchoInkMcpReadTools, type McpReadAccess } from "./tools";

type HttpModule = ReturnType<typeof getDesktopHttp>;
type HttpServer = ReturnType<HttpModule["createServer"]>;
type IncomingMessage = InstanceType<HttpModule["IncomingMessage"]>;
type ServerResponse = InstanceType<HttpModule["ServerResponse"]>;
type Socket = InstanceType<ReturnType<typeof getDesktopNet>["Socket"]>;
const { createServer } = getDesktopHttp();
const { Buffer } = getDesktopBuffer();
const { randomUUID, timingSafeEqual } = getDesktopCrypto();
export interface EchoInkMcpServerState { status: "stopped" | "starting" | "running" | "error"; port?: number; error?: string }
export class EchoInkMcpServer {
  private listener: HttpServer | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly active = new Set<McpServer>();
  private epoch = 0;
  private state: EchoInkMcpServerState = { status: "stopped" };
  private readonly observers = new Set<() => void>();
  private starting: Promise<void> | null = null;
  constructor(private readonly options: { tools: EchoInkMcpReadTools; access(): McpReadAccess; token(): string; version: string }) {}
  read(): Readonly<EchoInkMcpServerState> { return { ...this.state }; }
  subscribe(callback: () => void): () => void { this.observers.add(callback); return () => this.observers.delete(callback); }
  setupText(): string | null {
    return this.state.status === "running" && this.options.access().enabled && this.options.access().pro
      ? echoInkMcpSetupText(`http://127.0.0.1:${this.state.port}/mcp`, this.options.token()) : null;
  }
  /** Revocation is synchronous: outstanding reads/connections cannot send data. */
  revoke(): void {
    this.epoch += 1;
    for (const server of this.active) void server.close().catch(() => undefined);
    this.active.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }
  async start(preferredPort = 0): Promise<void> {
    if (this.starting) return this.starting;
    if (this.listener && this.state.status === "running") return;
    const access = this.options.access();
    if (!access.enabled || !access.pro) return;
    const epoch = this.epoch;
    this.starting = this.listen(preferredPort, epoch).finally(() => { this.starting = null; });
    return this.starting;
  }
  private async listen(preferredPort: number, epoch: number): Promise<void> {
    this.setState({ status: "starting" });
    const listener = createServer((request, response) => { void this.handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); });
    this.listener = listener;
    listener.on("connection", socket => { this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); });
    listener.requestTimeout = 30_000;
    listener.headersTimeout = 10_000;
    listener.maxRequestsPerSocket = 100;
    const bind = (port: number) => new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { listener.off("listening", ready); reject(error); };
      const ready = () => { listener.off("error", failed); resolve(); };
      listener.once("error", failed); listener.once("listening", ready); listener.listen(port, "127.0.0.1");
    });
    try {
      try { await bind(preferredPort); } catch (error) {
        if (preferredPort && (error as { code?: string }).code === "EADDRINUSE") await bind(0); else throw error;
      }
      if (epoch !== this.epoch || !this.options.access().enabled || !this.options.access().pro) { await this.closeListener(listener); return; }
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("listener_unavailable");
      this.setState({ status: "running", port: address.port });
    } catch {
      await this.closeListener(listener);
      if (epoch === this.epoch) this.setState({ status: "error", error: "Could not start the local MCP listener." });
    }
  }
  async stop(): Promise<void> {
    this.revoke();
    this.setState({ status: "stopped" });
    const listener = this.listener; this.listener = null;
    if (listener) await this.closeListener(listener);
    if (this.starting) await this.starting;
  }
  private closeListener(listener: HttpServer): Promise<void> {
    return new Promise(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); if (!listener.listening) resolve(); });
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = this.state.port;
    // Exact authorities prevent DNS rebinding; no Origin is normal for native clients.
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (!host || !hosts.has(host) || origin !== undefined && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(origin)) { response.writeHead(403).end(); return; }
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    if (!tokenMatches(request.headers.authorization, this.options.token())) { response.writeHead(401).end(); return; }
    if (!this.options.access().enabled || !this.options.access().pro) { response.writeHead(403).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
    if (Number(request.headers["content-length"] ?? 0) > 64_000) { response.writeHead(413).end(); return; }
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const input of request) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input as string);
      size += chunk.length;
      if (size > 64_000) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response.writeHead(400).end(); return; }
    const epoch = this.epoch;
    const assertRequest = () => { if (epoch !== this.epoch || !tokenMatches(request.headers.authorization, this.options.token())) throw Object.assign(new Error("Request revoked"), { code: "request_revoked" }); };
    // Stateless HTTP: each request owns a transport and request identity. No chat sessions or retained data.
    const server = new McpServer({ name: "EchoInk", version: this.options.version }, { capabilities: { tools: { listChanged: true } }, instructions: ECHOINK_MCP_INSTRUCTIONS });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => { assertRequest(); return { tools: this.options.tools.list() }; });
    server.server.setRequestHandler(CallToolRequestSchema, async input => {
      const envelope = await this.options.tools.call(input.params.name, input.params.arguments ?? {}, randomUUID(), assertRequest);
      assertRequest();
      return { content: [{ type: "text", text: JSON.stringify(envelope) }], isError: !envelope.ok };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    this.active.add(server);
    const cleanup = () => { this.active.delete(server); void server.close().catch(() => undefined); };
    response.once("close", cleanup);
    try { await server.connect(transport); assertRequest(); await transport.handleRequest(request, response, parsedBody); }
    catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  }
  private setState(state: EchoInkMcpServerState): void { this.state = state; for (const observer of this.observers) observer(); }
}
function tokenMatches(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const actual = Buffer.from(header), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
