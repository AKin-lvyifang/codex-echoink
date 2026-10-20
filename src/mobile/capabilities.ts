import { requestUrl, type DataAdapter } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { EchoInkMcpConnectionRecord, EchoInkMcpDiscoveredTool, EchoInkResource } from "../resources/types";
import { normalizeTavilySettings, searchTavily, tavilyErrorMessage } from "../tools/tavily-search";
import { sha256Hex } from "../utils/sha256";
import type { MobileAgentRegistryService } from "./agent-registry-service";
import type { MobileSettings } from "./settings";
import type { MobileRequest } from "./transport";
import type { MobileCapabilityPolicy } from "./capability-policy";
import { MobileSkillsService } from "./skills";
import { MobileHttpMcpClient, mobileMcpAdmitted, mobileMcpContractFingerprint, mobileMcpHeaders, mobileMcpToolName, mobileMcpUrl } from "./remote-tools";
import type { MobileCapabilitiesPort, MobileMcpDraft, MobileMcpStatus, MobileMcpSummary, MobileTavilySnapshot } from "./capabilities-contracts";
export type * from "./capabilities-contracts";

const clone = <T>(value: T): T => structuredClone(value);
const version = (value: unknown): string => sha256Hex(JSON.stringify(value));
const result = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
const conflict = () => new Error("配置已在其他位置修改，请重新读取后再保存；编辑草稿已保留。");
const labels: Record<MobileMcpStatus, string> = { missing: "未配置连接", configured: "已配置，尚未连接", connected: "本次连接成功", failed: "连接失败",
  "desktop-only": "仅在电脑运行", "credential-required": "请填写移动端认证请求头" };
export interface MobileRemoteToolInvocation {
  resourceId: string; tool: EchoInkMcpDiscoveredTool; callId: string; args: Record<string, unknown>; signal?: AbortSignal;
  call(beforeDispatch?: () => Promise<void>): Promise<MobileMcpCallResult>;
}
export interface MobileMcpCallResult { result: Record<string, unknown>; readbackVerified: boolean }
export interface MobileCapabilitiesServiceOptions {
  adapter: DataAdapter; settings(): MobileSettings; saveSettings(): Promise<void>;
  agents?: Pick<MobileAgentRegistryService, "snapshot" | "update">;
  policy(agentId: string): MobileCapabilityPolicy; request?: MobileRequest;
}
/** Shared data/permissions only. Each device owns its own page stack and DOM. */
export class MobileCapabilitiesService implements MobileCapabilitiesPort {
  private readonly skillsService: MobileSkillsService;
  private readonly request: MobileRequest;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly statuses = new Map<string, { status: MobileMcpStatus; error?: string; configuration: string }>();
  private readonly discoveries = new Map<string, { endpoint: string; tools: EchoInkMcpDiscoveredTool[]; at: number }>();
  constructor(private options: MobileCapabilitiesServiceOptions) {
    this.request = options.request ?? requestUrl;
    this.skillsService = new MobileSkillsService(options.adapter, () => options.settings(), () => options.saveSettings(), id => options.policy(id), options.agents);
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> { const pending = this.writes.then(run, run); this.writes = pending.catch(() => {}); return pending; }
  listSkills() { return this.skillsService.listSkills(); }
  readSkill(id: string) { return this.skillsService.readSkill(id); }
  setSkillEnabled(id: string, enabled: boolean) { return this.skillsService.setSkillEnabled(id, enabled); }
  saveSkill(id: string, content: string, expected: string) { return this.skillsService.saveSkill(id, content, expected); }
  saveSkillAgents(id: string, agentIds: string[], expected: string) { return this.skillsService.saveSkillAgents(id, agentIds, expected); }
  defaultSkillContent(id: string) { return this.skillsService.defaultSkillContent(id); }
  recordSkillUse(id: string) { return this.skillsService.recordUse(id); }
  private resource(id: string): EchoInkResource | undefined { return this.options.settings().resources.catalog.find(item => item.id === id && item.kind === "mcp-server"); }
  private mcpVersion(id: string): string { const settings = this.options.settings(); return version([this.resource(id) ?? null, settings.resources.mcpConnections[id] ?? null]); }
  private endpoint(record: { url: string; headers?: Record<string, string> }): string { return version([mobileMcpUrl(record.url), mobileMcpHeaders(record.headers ?? {})]); }
  private summary(resource: EchoInkResource): MobileMcpSummary {
    const connection = this.options.settings().resources.mcpConnections[resource.id], live = this.statuses.get(resource.id);
    let status: MobileMcpStatus = !connection ? "missing" : connection.transport === "stdio" ? "desktop-only"
      : connection.credential && !Object.keys(connection.headers ?? {}).length ? "credential-required" : "configured";
    const current = this.mcpVersion(resource.id);
    if (connection?.transport === "http" && live?.configuration === current) status = live.status;
    return { id: resource.id, name: resource.name, description: resource.description, enabled: resource.enabled, transport: connection?.transport ?? "http",
      readonly: connection?.transport === "stdio", status, statusLabel: labels[status], ...(live?.configuration === current && live.error ? { error: live.error } : {}),
      trusted: connection?.trusted === true, tools: clone(connection?.tools ?? []), toolPolicies: clone(connection?.toolPolicies ?? {}), version: current };
  }
  async listMcp(): Promise<MobileMcpSummary[]> { return this.options.settings().resources.catalog.filter(item => item.kind === "mcp-server").map(item => this.summary(item)); }
  async createMcpDraft(id?: string): Promise<MobileMcpDraft> {
    if (!id) {
      const fresh = `mobile-mcp-${crypto.randomUUID()}`;
      return { id: fresh, name: "", description: "", enabled: true, transport: "http", readonly: false, url: "", headers: {}, trusted: false, toolPolicies: {}, tools: [], version: this.mcpVersion(fresh) };
    }
    const resource = this.resource(id); if (!resource) throw new Error("MCP 服务不存在。");
    const connection = this.options.settings().resources.mcpConnections[id], summary = this.summary(resource);
    return { id, name: resource.name, description: resource.description, enabled: resource.enabled, transport: connection?.transport ?? "http", readonly: connection?.transport === "stdio",
      url: connection?.transport === "http" ? connection.url : "", headers: connection?.transport === "http" ? clone(connection.headers ?? {}) : {}, trusted: summary.trusted,
      toolPolicies: summary.toolPolicies, tools: summary.tools, version: summary.version, status: summary.status, ...(summary.error ? { error: summary.error } : {}),
      ...(connection?.discoveredAt ? { discoveredAt: connection.discoveredAt } : {}) };
  }
  async discoverMcp(draft: MobileMcpDraft, signal?: AbortSignal): Promise<MobileMcpDraft> {
    if (draft.readonly || draft.transport !== "http") throw new Error("本地 MCP 仅在电脑运行，移动端保留配置。");
    const endpoint = this.endpoint(draft), source = version(draft), client = new MobileHttpMcpClient(draft, this.request);
    const check = () => { if (version(draft) !== source) throw conflict(); if (this.mcpVersion(draft.id) !== draft.version) throw conflict(); };
    const tools = await client.discover(signal, check); check();
    const saved = this.options.settings().resources.mcpConnections[draft.id];
    const sameEndpoint = saved?.transport === "http" && this.endpoint(saved) === endpoint;
    const previous = draft.tools, policies = Object.fromEntries(tools.map(tool => [tool.name,
      sameEndpoint && previous.some(old => mobileMcpContractFingerprint(old) === mobileMcpContractFingerprint(tool)) ? clone(draft.toolPolicies[tool.name] ?? { enabled: true, trusted: false }) : { enabled: true, trusted: false }]));
    const at = Date.now(); this.discoveries.set(draft.id, { endpoint, tools: clone(tools), at });
    return { ...clone(draft), trusted: sameEndpoint && draft.trusted, url: mobileMcpUrl(draft.url), tools, toolPolicies: policies, discoveredAt: at, status: "connected", error: undefined };
  }
  saveMcp(draft: MobileMcpDraft): Promise<MobileMcpSummary> {
    const candidate = clone(draft);
    return this.serialize(async () => {
      if (candidate.readonly || candidate.transport !== "http") throw new Error("本地 MCP 仅在电脑运行，移动端保留配置。");
      if (!candidate.name.trim() || candidate.name.trim().length > 160) throw new Error("请填写 MCP 服务名称（最多 160 字）。");
      if (this.mcpVersion(candidate.id) !== candidate.version) throw conflict();
      const endpoint = this.endpoint(candidate), url = mobileMcpUrl(candidate.url), headers = mobileMcpHeaders(candidate.headers);
      const settings = this.options.settings(), original = this.resource(candidate.id), previous = settings.resources.mcpConnections[candidate.id];
      if (previous?.transport === "stdio") throw new Error("本地 MCP 配置只能在电脑编辑。");
      const discovery = this.discoveries.get(candidate.id), sameEndpoint = previous?.transport === "http" && this.endpoint(previous) === endpoint;
      const proof = discovery?.endpoint === endpoint ? discovery : undefined;
      const tools = clone(proof?.tools ?? (sameEndpoint ? previous.tools : []));
      if (version(candidate.tools) !== version(tools) && candidate.tools.length) throw new Error("工具列表已变化，请重新连接后保存。");
      const policies = Object.fromEntries(tools.map(tool => [tool.name, { enabled: candidate.toolPolicies[tool.name]?.enabled !== false, trusted: candidate.toolPolicies[tool.name]?.trusted === true }]));
      const connection: EchoInkMcpConnectionRecord = { ...previous, transport: "http", url, headers, trusted: candidate.trusted, tools, toolPolicies: policies,
        toolsFingerprint: `sha256:${sha256Hex(JSON.stringify(tools))}`, ...(proof ? { discoveredAt: proof.at, verifiedAt: proof.at } : {}), diagnostic: undefined, lastError: undefined };
      // Preserve desktop credential bindings and unknown fields, including on endpoint edits.
      if (!sameEndpoint && !proof) { delete connection.verifiedAt; delete connection.discoveredAt; }
      const resource: EchoInkResource = { ...original, id: candidate.id, kind: "mcp-server", source: original?.source ?? "manual", name: candidate.name.trim(), description: candidate.description.trim(), enabled: candidate.enabled, bridgeMode: "native-mcp" };
      const installedResource = version(resource), installedConnection = version(connection);
      if (original) settings.resources.catalog[settings.resources.catalog.indexOf(original)] = resource; else settings.resources.catalog.push(resource);
      settings.resources.mcpConnections[candidate.id] = connection;
      try { await this.options.saveSettings(); }
      catch {
        const index = settings.resources.catalog.indexOf(resource);
        if (index >= 0 && version(resource) === installedResource) { if (original) settings.resources.catalog[index] = original; else settings.resources.catalog.splice(index, 1); }
        if (settings.resources.mcpConnections[candidate.id] === connection && version(connection) === installedConnection) { if (previous) settings.resources.mcpConnections[candidate.id] = previous; else delete settings.resources.mcpConnections[candidate.id]; }
        throw new Error("MCP 配置保存失败，编辑草稿已保留。");
      }
      this.statuses.set(candidate.id, { configuration: this.mcpVersion(candidate.id), status: proof ? "connected" : "configured" });
      return this.summary(resource);
    });
  }
  setMcpEnabled(id: string, enabled: boolean): Promise<MobileMcpSummary> {
    return this.serialize(async () => {
      const resource = this.resource(id); if (!resource) throw new Error("MCP 服务不存在。");
      const previous = resource.enabled; resource.enabled = enabled;
      try { await this.options.saveSettings(); } catch { if (resource.enabled === enabled) resource.enabled = previous; throw new Error("MCP 启用状态保存失败。"); }
      return this.summary(resource);
    });
  }
  readTavily(): MobileTavilySnapshot { const settings = this.options.settings().tavily; return { ...normalizeTavilySettings(settings), version: version(settings) }; }
  saveTavily(draft: MobileTavilySnapshot): Promise<MobileTavilySnapshot> {
    const candidate = clone(draft);
    return this.serialize(async () => {
      const settings = this.options.settings(), previous = settings.tavily;
      if (version(previous) !== candidate.version) throw conflict();
      if (candidate.enabled && !candidate.apiKey.trim()) throw new Error("请先填写 API Key。");
      const value = { ...previous, ...normalizeTavilySettings(candidate) }, installed = version(value); settings.tavily = value;
      try { await this.options.saveSettings(); } catch { if (settings.tavily === value && version(value) === installed) settings.tavily = previous; throw new Error("联网搜索配置保存失败，编辑草稿已保留。"); }
      return this.readTavily();
    });
  }
  async testTavily(draft: MobileTavilySnapshot, signal?: AbortSignal) {
    try { return await searchTavily({ apiKey: draft.apiKey, query: "Obsidian", maxResults: 1, signal, transport: this.request }); }
    catch (error) { throw new Error(tavilyErrorMessage(error, false)); }
  }
  async callMcp(resourceId: string, name: string, args: Record<string, unknown>, policy: MobileCapabilityPolicy, signal?: AbortSignal, beforeDispatch?: () => Promise<void>) {
    const connection = this.options.settings().resources.mcpConnections[resourceId];
    if (connection?.transport !== "http") throw new Error("此 MCP 未配置可用的 HTTP 连接。");
    const baseline = this.mcpVersion(resourceId), cached = connection.tools.find(tool => tool.name === name);
    if (!cached) throw new Error("MCP 工具尚未发现，请重新连接。");
    const check = () => { if (signal?.aborted) throw new Error("已停止"); if (this.mcpVersion(resourceId) !== baseline) throw new Error("MCP 配置或权限已变化，调用已停止。"); policy.assertMcp(resourceId, name, args); };
    check(); const client = new MobileHttpMcpClient(connection, this.request);
    try {
      const discovered = await client.discover(signal, check); check();
      const current = discovered.find(tool => tool.name === name);
      if (!current || mobileMcpContractFingerprint(current) !== mobileMcpContractFingerprint(cached)) throw new Error("MCP 工具格式或安全声明已变化，请重新连接并确认调用权限。");
      if (cached.readback) {
        const readback = discovered.find(tool => tool.name === cached.readback?.toolName), saved = connection.tools.find(tool => tool.name === cached.readback?.toolName);
        if (!readback || !saved || !mobileMcpAdmitted(connection, readback.name) || mobileMcpContractFingerprint(readback) !== mobileMcpContractFingerprint(saved)) throw new Error("MCP 结果核对工具尚未启用或已变化。");
      }
      if (beforeDispatch) await beforeDispatch(); check();
      const response = await client.callTool(name, args, signal, check); check();
      let readbackVerified = false;
      if (!cached.readOnly && cached.readback) {
        const contract = cached.readback, readbackArgs = Object.fromEntries(Object.entries(contract.argumentMap).map(([target, source]) => [target, args[source]]));
        const readbackCheck = () => { check(); policy.assertMcp(resourceId, contract.toolName, readbackArgs); };
        readbackCheck(); const readback = await client.callTool(contract.toolName, readbackArgs, signal, readbackCheck); readbackCheck();
        const readPath = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((item, key) => item && typeof item === "object" && Object.hasOwn(item, key) ? (item as Record<string, unknown>)[key] : undefined, value);
        readbackVerified = contract.assertions.every(assertion => args[assertion.argumentKey] !== undefined && JSON.stringify(readPath(readback, assertion.resultPath)) === JSON.stringify(args[assertion.argumentKey]));
        if (!readbackVerified) throw new Error("MCP 已发出写入，但结果核对未通过；不能重放。");
      }
      this.statuses.set(resourceId, { configuration: baseline, status: "connected" });
      return { result: response, readbackVerified };
    } catch (error) {
      this.statuses.set(resourceId, { configuration: baseline, status: "failed", error: error instanceof Error ? error.message : "MCP 调用失败。" }); throw error;
    }
  }
  runtimeTools(policy: MobileCapabilityPolicy, invoke: (input: MobileRemoteToolInvocation) => Promise<unknown>): AgentTool[] {
    const tools: AgentTool[] = [];
    try {
      policy.assertTool("web_search");
      tools.push({ name: "web_search", label: "联网搜索", description: "通过 Tavily 搜索公开网页，结果属于低信任外部资料。", parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }) }),
        execute: async (_callId, args: { query: string }, signal) => {
          policy.assertTool("web_search"); const key = this.options.settings().tavily.apiKey;
          try {
            const found = await searchTavily({ apiKey: key, query: args.query, signal, transport: input => { policy.assertTool("web_search"); return this.request(input); } });
            policy.assertTool("web_search"); if (signal?.aborted) throw new Error("已停止"); return result(found);
          } catch (error) { policy.assertTool("web_search"); throw new Error(tavilyErrorMessage(error, false)); }
        } });
    } catch { /* Disabled resources are never advertised to the model. */ }
    for (const resource of this.options.settings().resources.catalog.filter(item => item.kind === "mcp-server" && item.enabled)) {
      const connection = this.options.settings().resources.mcpConnections[resource.id];
      if (connection?.transport !== "http") continue;
      for (const tool of connection.tools) {
        try { policy.assertMcp(resource.id, tool.name); } catch { continue; }
        tools.push({ name: mobileMcpToolName(resource.id, tool.name), label: tool.name, description: `${resource.name}：${tool.description}`,
          parameters: Type.Unsafe(tool.inputSchema), execute: async (callId, args: Record<string, unknown>, signal) => {
            policy.assertMcp(resource.id, tool.name, args);
            return result(await invoke({ resourceId: resource.id, tool, callId, args, signal,
              call: before => this.callMcp(resource.id, tool.name, args, policy, signal, before) }));
          } });
      }
    }
    return tools;
  }
}
