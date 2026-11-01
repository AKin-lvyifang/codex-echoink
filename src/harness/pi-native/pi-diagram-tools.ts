import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolCallEvent, type ToolDefinition, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getDesktopCrypto } from "../../platform/desktop-crypto";
import type { DrawingCreation } from "../../excalidraw/service";
import type { DrawingReceipt } from "../../excalidraw/service";
import type { FileDomainReceiptStore } from "./domain-receipt-store";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import type { PiWorkspaceAccess } from "./pi-workspace-access";
import { canonicalJsonStringify, normalizeJsonValue, type ApprovalOperationContract, type FileApprovalTicketStore, type JsonValue, type WriteToolAuthorizationContext } from "./tool-authorization";
import { secureVaultToolResult, EchoInkVaultToolEgressPolicy } from "./vault-tool-result-safety";

export const PI_DIAGRAM_TOOL_ID = "diagram_create" as const;
interface Identity { vaultId: string; conversationId: string; piSessionId: string; productRunId: string; userEntryId: string }
export interface PiDiagramPort {
  disabledReason(): string | null;
  prepare(input: Record<string, unknown>, requestId: string): Promise<DrawingCreation>;
  check(creation: DrawingCreation): Promise<void>;
  create(creation: DrawingCreation): Promise<DrawingReceipt>;
  reconcile(creation: DrawingCreation): Promise<DrawingReceipt>;
  version(path: string): Promise<string>;
  open(creation: DrawingCreation): Promise<void>;
}
interface Options {
  port: PiDiagramPort;
  identity(): Identity;
  access(): PiWorkspaceAccess | null | undefined;
  resumeOperationIds(): readonly string[];
  assertToolAllowed(name: string, args: Readonly<Record<string, unknown>>, target?: unknown, operation?: { productRunId: string; toolCallId: string }): Promise<void>;
  approvals: FileApprovalTicketStore; receipts: FileDomainReceiptStore; userId: string; deviceId: string;
  confirm(input: Identity & { requestId: string; toolCallId: string; target: JsonValue; preview: JsonValue; signal?: AbortSignal }): Promise<boolean>;
}
interface Call { input: Record<string, unknown>; creation: DrawingCreation; identity: Identity; authorization?: Readonly<WriteToolAuthorizationContext>; consumed?: boolean; result?: Record<string, unknown> }
const { createHash } = getDesktopCrypto();
const digest = (value: unknown) => createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("手绘图参数需要 title、elements 和可选 style。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["title", "elements", "style"].includes(key)) || input.style !== undefined && input.style !== "white" && input.style !== "blackboard") throw new Error("手绘图样式仅支持 white 或 blackboard。");
  return normalizeJsonValue({ ...input, style: input.style ?? "white" }) as Record<string, unknown>;
}
/** Approval and durable effect records bind the complete immutable scene and exact path. */
export class PiDiagramToolSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_DIAGRAM_TOOL_ID;
  private readonly calls = new Map<string, Call>();
  private readonly seen = new Set<string>();
  constructor(private readonly options: Options) {}
  private access(): void {
    const access = this.options.access(), reason = this.options.port.disabledReason();
    if (reason) throw new Error(reason);
    if (access?.mode === "plan") throw new Error("计划模式只讨论方案，请切换到 Agent 模式后画图。");
    if (!access || access.permission === "read-only") throw new Error("当前是只读权限，请允许写入后再画图。");
  }
  private async check(call: Call, id: string): Promise<void> {
    this.access();
    if (canonicalJsonStringify(call.identity) !== canonicalJsonStringify(this.options.identity())) throw new Error("画图请求已变化，请重新发送。");
    await this.options.assertToolAllowed(this.toolName, call.input, { path: call.creation.path }, { productRunId: call.identity.productRunId, toolCallId: id });
    await this.options.port.check(call.creation);
  }
  async handleToolCall(event: ToolCallEvent, signal?: AbortSignal) {
    try {
      if (this.seen.has(event.toolCallId)) throw new Error("画图工具请求已处理，不能重复执行。");
      this.seen.add(event.toolCallId); this.access(); signal?.throwIfAborted();
      const input = inputObject(event.input), identity = { ...this.options.identity() };
      const resumeIds = new Set(this.options.resumeOperationIds());
      // No in-memory request cache is needed here: journals survive app restarts.
      for (const view of await this.options.receipts.listUiViews({ conversationId: identity.conversationId })) {
        if (view.toolId !== this.toolName) continue;
        const journal = await this.options.receipts.readOperation(view.operationIdentity);
        if (!journal) continue;
        const target = journal.resolvedTarget as Record<string, JsonValue>, version = journal.targetVersion as Record<string, JsonValue>;
        const resumed = resumeIds.has(view.operationIdentity);
        const unresolved = journal.effectState !== "authorized" && view.receipt?.status !== "completed";
        if (!resumed && (version.userEntryId !== identity.userEntryId || !unresolved && version.inputDigest !== digest(input))) continue;
        const creation = target.creation as unknown as DrawingCreation;
        if (!creation?.path) throw new Error("原图记录不完整，请先核对原任务，不能换名重建。");
        const receipt = await this.options.port.reconcile(creation);
        this.calls.set(event.toolCallId, { input, creation, identity, result: { status: receipt.verified ? "completed" : "uncertain", readbackVerified: receipt.verified, path: creation.path, title: creation.output.title, style: creation.style, boxCount: creation.output.boxCount, arrowCount: creation.output.arrowCount, reused: true, reason: receipt.verified ? "原图已存在，本次未重复创建。" : "原图结果未确认，请核对原路径，不能换名重建。" } });
        return;
      }
      await this.options.assertToolAllowed(this.toolName, input);
      const creation = await this.options.port.prepare(input, `diagram-${digest({ ...identity, toolCallId: event.toolCallId })}`);
      const call: Call = { input, identity, creation };
      await this.check(call, event.toolCallId);
      const preview = normalizeJsonValue({ domain: "excalidraw", path: creation.path, style: creation.style === "blackboard" ? "黑板" : "手绘白底", boxCount: creation.output.boxCount, arrowCount: creation.output.arrowCount, elements: creation.output.elements });
      const { userEntryId: _userEntryId, ...runIdentity } = identity;
      const contract: ApprovalOperationContract = { ...runIdentity, toolCallId: event.toolCallId, toolId: this.toolName,
        userId: this.options.userId, deviceId: this.options.deviceId, toolVersion: "diagram-v1", policyVersion: "diagram-v1",
        normalizedArguments: normalizeJsonValue(input), resolvedTarget: normalizeJsonValue({ path: creation.path, style: creation.style, creation }),
        targetVersion: { userEntryId: identity.userEntryId, inputDigest: digest(input), beforeVersion: null }, preview };
      const issuedAt = Date.now(), ticket = await this.options.approvals.issue({ ...contract, issuedAt, expiresAt: issuedAt + 300_000 });
      let accepted = false;
      try { accepted = await this.options.confirm({ ...identity, requestId: ticket.ticketId, toolCallId: event.toolCallId, target: ticket.resolvedTarget, preview, signal }); }
      finally {
        if (!accepted || signal?.aborted) await this.options.approvals.resolve({ ticketId: ticket.ticketId, productRunId: identity.productRunId, toolCallId: event.toolCallId, resolution: signal?.aborted ? "cancelled" : "denied" });
      }
      if (!accepted || signal?.aborted) throw new Error("已取消，尚未创建手绘图。");
      await this.check(call, event.toolCallId);
      call.authorization = await this.options.approvals.consume({ ticketId: ticket.ticketId, operationIdentity: ticket.operationIdentity, contract });
      await this.options.receipts.beginAuthorizedOperation(call.authorization);
      this.calls.set(event.toolCallId, call);
    } catch (error) { return { block: true as const, reason: error instanceof Error ? error.message : "手绘图检查失败，尚未写入文件。" }; }
  }
  async execute(id: string, value: unknown, signal?: AbortSignal): Promise<void> {
    const call = this.calls.get(id);
    if (!call || call.consumed || digest(inputObject(value)) !== digest(call.input)) throw new Error("画图授权不匹配。");
    call.consumed = true;
    if (call.result) return;
    let started = false;
    try {
      signal?.throwIfAborted(); await this.check(call, id);
      await this.options.receipts.markEffectStarted(call.authorization!.operationIdentity); started = true;
      const receipt = await this.options.port.create(call.creation);
      const version = receipt.verified ? await this.options.port.version(call.creation.path) : null;
      const result = { status: receipt.verified ? "completed" as const : "uncertain" as const, path: call.creation.path, readbackVerified: receipt.verified,
        boxCount: call.creation.output.boxCount, arrowCount: call.creation.output.arrowCount, style: call.creation.style,
        ...(receipt.error ? { reason: receipt.error } : {}) };
      await this.options.receipts.markEffectCompleted(call.authorization!.operationIdentity);
      await this.options.receipts.persistReceipt({ operationIdentity: call.authorization!.operationIdentity, status: result.status,
        safeSummary: normalizeJsonValue(result), readback: { checkedAt: Date.now(), readbackVerified: receipt.verified, observedTargetVersion: version, safeSummary: receipt.verified ? "Drawing saved and verified" : "Inspect original path; do not recreate" } });
      call.result = result;
      if (receipt.verified) await this.options.port.open(call.creation).catch(() => undefined);
    } catch (error) {
      call.result = { status: started ? "uncertain" : signal?.aborted ? "cancelled" : "failed", path: call.creation.path, readbackVerified: false, reason: started ? "绘图结果未确认，请核对原路径，不能换名重建。" : error instanceof Error ? error.message : "手绘图尚未创建。" };
      if (!started) await this.options.receipts.persistReceipt({ operationIdentity: call.authorization!.operationIdentity, status: signal?.aborted ? "cancelled" : "failed", safeSummary: normalizeJsonValue(call.result), readback: { checkedAt: Date.now(), readbackVerified: false, observedTargetVersion: null, safeSummary: "No drawing effect started" } });
      // A started operation deliberately has no success receipt: recovery must read its original path.
    }
  }
  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId); this.calls.delete(event.toolCallId);
    const result = call?.consumed && call.result ? call.result : { status: "failed", reason: "画图授权不匹配。" };
    const secured = await secureVaultToolResult({ toolId: this.toolName, effectType: "user_write", egressPolicy: "echoink-configured-provider-v1", value: result, sizeLimitBytes: 8000, egress: new EchoInkVaultToolEgressPolicy() });
    return { content: [{ type: "text" as const, text: secured.text }], details: { source: "echoink-diagram", ...result }, isError: result.status !== "completed" || secured.truncated };
  }
}
export function createPiDiagramToolDefinition(security: PiDiagramToolSecurity): ToolDefinition {
  return defineTool({ name: PI_DIAGRAM_TOOL_ID, label: "创建 Excalidraw 手绘图", description: '免费创建新的 Excalidraw 手绘图。支持无资料画图、emoji、框和吸附箭头。先检查，再按最终路径、样式与完整元素请求确认；只有已保存回执才能报告成功。默认白底，黑板风用 blackboard。检查错误按工具返回修复一次。不能修改已有图。\n最小参数：{"title":"主题","style":"white","elements":[{"id":"a","type":"rectangle","x":0,"y":0,"width":320,"height":140,"label":{"text":"📖 重点"}}]}；连线用 {"id":"ab","type":"arrow","start":{"id":"a"},"end":{"id":"b"}}，两端须为现存不同框。',
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 20 }), elements: Type.Array(Type.Any(), { minItems: 1, maxItems: 80 }), style: Type.Optional(Type.Union([Type.Literal("white"), Type.Literal("blackboard")])) }, { additionalProperties: false }),
    execute: async (id, args, signal) => { await security.execute(id, args, signal); return { content: [{ type: "text" as const, text: "diagram_result_pending_safety" }], details: {} }; } });
}
