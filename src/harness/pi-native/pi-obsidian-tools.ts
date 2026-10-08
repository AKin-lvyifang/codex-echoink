import { isDeepStrictEqual } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolCallEvent, type ToolResultEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import { secureVaultToolResult, EchoInkVaultToolEgressPolicy } from "./vault-tool-result-safety";
import { normalizeJsonValue, canonicalJsonStringify, type JsonValue, type ApprovalOperationContract, type FileApprovalTicketStore, type WriteToolAuthorizationContext } from "./tool-authorization";
import type { FileDomainReceiptStore } from "./domain-receipt-store";
import type { PiWorkspaceAccess } from "./pi-workspace-access";
import { OBSIDIAN_CLI_COMMANDS, normalizeObsidianCliRequest, obsidianCliEffect, type ObsidianCliRequest, type ObsidianCliEffect } from "./obsidian-cli-policy";
export { OBSIDIAN_CLI_COMMANDS, normalizeObsidianCliRequest, type ObsidianCliRequest } from "./obsidian-cli-policy";

export const PI_OBSIDIAN_TOOL_IDS = ["obsidian_context", "obsidian_cli", "obsidian_plugin_search"] as const;
export type PiObsidianToolId = typeof PI_OBSIDIAN_TOOL_IDS[number];
export interface ObsidianCliResult {
  available: boolean;
  engine: "obsidian-official-cli" | "echoink-finance-service";
  command: string;
  status: "completed" | "empty" | "unsupported" | "unavailable" | "failed" | "cancelled" | "truncated" | "uncertain";
  output?: string; reason?: string; readbackVerified?: boolean; observedTargetVersion?: JsonValue;
  target?: JsonValue; backend?: string;
}
export interface PreparedObsidianOperation {
  effect: ObsidianCliEffect;
  target: JsonValue;
  targetVersion: JsonValue;
  preview: JsonValue;
  unavailable?: ObsidianCliResult;
  execute(signal?: AbortSignal, onEffectStarted?: () => Promise<void>): Promise<ObsidianCliResult>;
}
export interface ObsidianNativePort {
  context(): Promise<unknown>;
  prepare(request: ObsidianCliRequest, signal?: AbortSignal): Promise<PreparedObsidianOperation>;
  cli(request: ObsidianCliRequest, signal?: AbortSignal): Promise<ObsidianCliResult>;
  pluginSearch(query: string, limit: number, signal?: AbortSignal): Promise<unknown>;
}
interface RunIdentity { vaultId: string; conversationId: string; piSessionId: string; productRunId: string }
export interface ObsidianApprovalInput extends RunIdentity {
  requestId: string; toolCallId: string; toolId: "obsidian_cli"; target: JsonValue; preview: JsonValue; signal: AbortSignal | undefined;
}
export interface PiObsidianSecurityOptions {
  currentAccess?: () => PiWorkspaceAccess | null | undefined;
  currentRunIdentity?: () => RunIdentity;
  approvals?: FileApprovalTicketStore;
  receipts?: FileDomainReceiptStore;
  confirmation?: { confirm(input: ObsidianApprovalInput): Promise<boolean> };
  userId?: string; deviceId?: string;
}
interface NativeCall {
  toolName: PiObsidianToolId;
  input: Record<string, unknown>;
  effect: ObsidianCliEffect;
  state: "authorized" | "consumed" | "result_ready";
  prepared?: PreparedObsidianOperation;
  authorization?: Readonly<WriteToolAuthorizationContext>;
  identity?: RunIdentity;
  result?: unknown;
  isError?: boolean;
}
function argumentsFor(tool: string, input: unknown): Record<string, unknown> {
  if (!PI_OBSIDIAN_TOOL_IDS.some(name => name === tool) || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("obsidian_invalid_request");
  const args = input as Record<string, unknown>;
  if (tool === "obsidian_context") { if (Object.keys(args).length) throw new Error("obsidian_invalid_request"); return {}; }
  if (tool === "obsidian_plugin_search") {
    if (Object.keys(args).some(key => !["query", "limit"].includes(key)) || typeof args.query !== "string" || !args.query.trim() || args.query.length > 200 || /[\0\r\n]/u.test(args.query)
      || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20)) throw new Error("obsidian_invalid_request");
    return { query: args.query, limit: args.limit ?? 10 };
  }
  return { ...normalizeObsidianCliRequest(args) };
}
/** Native operations share exact single-consume Tickets, confirmation UI and durable Receipts. */
export class PiObsidianToolSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_OBSIDIAN_TOOL_IDS[0];
  readonly toolNames = PI_OBSIDIAN_TOOL_IDS;
  private readonly calls = new Map<string, NativeCall>();
  private readonly seen = new Set<string>();
  private port?: ObsidianNativePort;
  constructor(private readonly options: PiObsidianSecurityOptions = {}) {}
  bindPort(port: ObsidianNativePort): void {
    if (this.port && this.port !== port) throw new Error("obsidian_port_already_bound");
    this.port = port;
  }
  async handleToolCall(event: ToolCallEvent, signal?: AbortSignal) {
    if (this.seen.has(event.toolCallId)) return { block: true as const, reason: "authorization_failed" };
    this.seen.add(event.toolCallId);
    try {
      if (signal?.aborted) throw new Error("approval_cancelled");
      const input = argumentsFor(event.toolName, event.input);
      const request = event.toolName === "obsidian_cli" ? normalizeObsidianCliRequest(input) : undefined;
      const effect = request ? obsidianCliEffect(request) : "read";
      const access = this.options.currentAccess?.();
      if (effect !== "read" && (!access || access.mode === "plan" || access.permission === "read-only")) throw new Error("tool_policy_blocked");
      const call: NativeCall = { toolName: event.toolName as PiObsidianToolId, input, effect, state: "authorized" };
      if (request) {
        if (!this.port) throw new Error("authorization_failed");
        call.prepared = await this.port.prepare(request, signal);
        if (effect !== call.prepared.effect) throw new Error("authorization_failed");
        if (!call.prepared.unavailable && (effect === "note_write" || effect === "plugin_write")) {
          const { approvals, receipts, confirmation, currentRunIdentity, userId, deviceId } = this.options;
          if (!approvals || !receipts || !confirmation || !currentRunIdentity || !userId || !deviceId) throw new Error("authorization_failed");
          const identity = currentRunIdentity();
          if (identity.vaultId !== approvals.vaultId) throw new Error("authorization_failed");
          call.identity = { ...identity };
          const prior = await receipts.listUiViews({ conversationId: identity.conversationId });
          for (const row of prior.filter(row => row.toolId === "obsidian_cli" && (!row.receipt || row.receipt.status === "uncertain"))) {
            const operation = await receipts.readOperation(row.operationIdentity);
            const fingerprint = (version: JsonValue) => version && typeof version === "object" && !Array.isArray(version) ? (version as Record<string, JsonValue>).effectArgumentsSha256 : undefined;
            if (operation && operation.effectState !== "authorized" && canonicalJsonStringify(operation.resolvedTarget) === canonicalJsonStringify(call.prepared.target)
              && (!fingerprint(operation.targetVersion) || fingerprint(operation.targetVersion) === fingerprint(call.prepared.targetVersion))) throw new Error("obsidian_cli_previous_result_uncertain_do_not_retry");
          }
          const contract: ApprovalOperationContract = {
            ...identity, toolCallId: event.toolCallId, toolId: "obsidian_cli", userId, deviceId,
            toolVersion: "obsidian-public-cli-v1", policyVersion: "obsidian-cli-policy-v1",
            normalizedArguments: normalizeJsonValue(input), resolvedTarget: call.prepared.target,
            targetVersion: call.prepared.targetVersion, preview: call.prepared.preview
          };
          const issuedAt = Date.now();
          const ticket = await approvals.issue({ ...contract, issuedAt, expiresAt: issuedAt + 300_000 });
          let accepted: boolean;
          try {
            accepted = await confirmation.confirm({ ...identity, toolId: "obsidian_cli", requestId: ticket.ticketId, toolCallId: event.toolCallId, target: ticket.resolvedTarget, preview: ticket.preview, signal });
          } catch {
            await approvals.resolve({ ticketId: ticket.ticketId, productRunId: identity.productRunId, toolCallId: event.toolCallId, resolution: "cancelled" });
            throw new Error("approval_cancelled");
          }
          if (!accepted || signal?.aborted) {
            const status = signal?.aborted ? "cancelled" : "denied";
            await approvals.resolve({ ticketId: ticket.ticketId, productRunId: identity.productRunId, toolCallId: event.toolCallId, resolution: status });
            throw new Error(status === "cancelled" ? "approval_cancelled" : "approval_denied");
          }
          call.authorization = await approvals.consume({ ticketId: ticket.ticketId, operationIdentity: ticket.operationIdentity, contract });
          await receipts.beginAuthorizedOperation(call.authorization);
        }
      }
      this.calls.set(event.toolCallId, call);
    } catch (error) {
      const code = error instanceof Error ? error.message : "tool_policy_blocked";
      return { block: true as const, reason: ["approval_denied", "approval_cancelled", "authorization_failed"].includes(code) || /^obsidian_[a-z_]+$/u.test(code) ? code : "tool_policy_blocked" };
    }
  }
  consume(id: string, tool: PiObsidianToolId, input: unknown): NativeCall {
    const call = this.calls.get(id);
    if (!call || call.state !== "authorized" || call.toolName !== tool || !isDeepStrictEqual(call.input, argumentsFor(tool, input))) throw new Error("obsidian_authorization_failed");
    if (call.identity && !isDeepStrictEqual(call.identity, this.options.currentRunIdentity?.())) throw new Error("obsidian_authorization_failed");
    const access = this.options.currentAccess?.();
    if (call.effect !== "read" && (!access || access.mode === "plan" || access.permission === "read-only")) throw new Error("tool_policy_blocked");
    call.state = "consumed";
    return call;
  }
  async execute(id: string, tool: PiObsidianToolId, input: unknown, signal?: AbortSignal): Promise<void> {
    const call = this.consume(id, tool, input);
    let started = false;
    let result: unknown;
    try {
      if (signal?.aborted) throw new Error("obsidian_cli_cancelled");
      if (tool === "obsidian_context") result = await this.port!.context();
      else if (tool === "obsidian_plugin_search") result = await this.port!.pluginSearch(String(call.input.query), Number(call.input.limit), signal);
      else result = await call.prepared!.execute(signal, async () => {
        if (signal?.aborted) throw new Error("obsidian_cli_cancelled");
        if (call.authorization) await this.options.receipts!.markEffectStarted(call.authorization.operationIdentity);
        started = true;
      });
    } catch (error) {
      result = { status: started ? "uncertain" : signal?.aborted ? "cancelled" : "failed", reason: started ? "obsidian_cli_result_uncertain_do_not_retry" : error instanceof Error ? error.message : "obsidian_cli_failed" };
    }
    if (call.authorization) {
      const value = result as Partial<ObsidianCliResult>;
      const verified = value.readbackVerified === true;
      const status = started ? value.status === "completed" && verified ? "completed" : "uncertain" : value.status === "cancelled" ? "cancelled" : "failed";
      try {
        if (started) await this.options.receipts!.markEffectCompleted(call.authorization.operationIdentity);
        await this.options.receipts!.persistReceipt({
          operationIdentity: call.authorization.operationIdentity, status,
          safeSummary: normalizeJsonValue({ source: "echoink-obsidian", command: call.input.command, status, readbackVerified: verified }),
          readback: { checkedAt: Date.now(), readbackVerified: verified, observedTargetVersion: value.observedTargetVersion ?? null, safeSummary: verified ? "Target readback verified" : "Result not verified; do not retry automatically" }
        });
        result = { ...value, status, ...(status === "uncertain" ? { reason: "obsidian_cli_result_uncertain_do_not_retry" } : {}) };
      } catch { result = { ...value, status: "uncertain", reason: "obsidian_cli_receipt_uncertain_do_not_retry" }; }
    }
    call.result = result;
    const status = (result as { status?: string })?.status;
    call.isError = !!status && !["completed", "empty"].includes(status);
    call.state = "result_ready";
  }
  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId);
    this.calls.delete(event.toolCallId);
    const valid = call?.toolName === event.toolName && call?.state === "result_ready";
    const result = await secureVaultToolResult({ toolId: event.toolName, effectType: call?.effect === "note_write" || call?.effect === "plugin_write" ? "user_write" : "read", egressPolicy: "echoink-configured-provider-v1", value: valid ? call.result : { error: "obsidian_authorization_failed" }, sizeLimitBytes: 32_000, egress: new EchoInkVaultToolEgressPolicy() });
    return { content: [{ type: "text" as const, text: result.text }], details: { source: "echoink-obsidian", toolCallId: event.toolCallId, effect: call?.effect, status: (call?.result as { status?: string })?.status, readbackVerified: (call?.result as ObsidianCliResult)?.readbackVerified, truncated: result.truncated }, isError: !valid || call?.isError === true || result.truncated };
  }
}
export function createPiObsidianToolDefinitions(port: ObsidianNativePort, security: PiObsidianToolSecurity): ToolDefinition[] {
  security.bindPort(port);
  const text = () => ({ content: [{ type: "text" as const, text: "obsidian_result_pending_safety" }], details: {} });
  const strings = Object.fromEntries(["path", "file", "folder", "query", "ext", "name", "title", "view", "content", "id", "ref", "info", "format", "sort", "filter", "status", "paneType"].map(key => [key, Type.Optional(Type.String({ minLength: 1, maxLength: key === "content" ? 24_000 : 1_000 }))]));
  const flags = Object.fromEntries("total counts verbose active daily done todo case words characters resolve newtab open inline versions enable".split(" ").map(key => [key, Type.Optional(Type.Boolean())]));
  const numbers = Object.fromEntries(["limit", "line", "version", "from", "to"].map(key => [key, Type.Optional(Type.Integer({ minimum: 1, maximum: key === "limit" ? 20 : 1_000_000 }))]));
  return [defineTool({ name: "obsidian_context", label: "读取原生日记设置", description: "用户明确要保存日记时读取原生目录、日期格式、模板和当天精确路径。只读。", parameters: Type.Object({}, { additionalProperties: false }), execute: async (id, args, signal) => { await security.execute(id, "obsidian_context", args, signal); return text(); } }),
    defineTool({ name: "obsidian_cli", label: "Obsidian 官方命令", description: `调用官方公开 CLI，固定当前 Vault，支持 ${OBSIDIAN_CLI_COMMANDS.join("/")}。参数严格按对应命令校验，task 只查询。查询无需确认；笔记和插件副作用沿用确认与回执，Plan/只读禁止副作用。文件命令需精确 path 或唯一 file；base:views 需 path 且活动 Base 匹配；base:create 新增记录，财务账本须带 finance 对象并由现有财务服务写入。自身停用/卸载/重载拒绝。结果不确定时不要重试，先查询核对。CLI read 不提供 expectedVersion；原生 note_create/note_update/metadata_update 保留。CLI 不可用时说明原因。插件公开目录搜索另用 obsidian_plugin_search。`,
      parameters: Type.Object({ command: Type.Union(OBSIDIAN_CLI_COMMANDS.map(name => Type.Literal(name))), ...strings, ...flags, ...numbers,
        finance: Type.Optional(Type.Object({ date: Type.String(), merchant: Type.String(), amountCents: Type.Integer({ minimum: 1 }), kind: Type.Union([Type.Literal("expense"), Type.Literal("income"), Type.Literal("refund"), Type.Literal("transfer")]), ...Object.fromEntries(["category", "account", "description", "currency", "note", "billPlanId"].map(key => [key, Type.Optional(Type.String())])) }, { additionalProperties: false }))
      }, { additionalProperties: false }), execute: async (id, args, signal) => { await security.execute(id, "obsidian_cli", args, signal); return text(); } }),
    defineTool({ name: "obsidian_plugin_search", label: "搜索 Obsidian 社区插件", description: "只读搜索 Obsidian 官方社区插件目录，返回已核实插件 ID、名称、作者、说明和仓库。已安装 plugins 清单不等于目录搜索；搜索不安装，后续安装用 obsidian_cli plugin:install 并确认。", parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }), execute: async (id, args, signal) => { await security.execute(id, "obsidian_plugin_search", args, signal); return text(); } })];
}
