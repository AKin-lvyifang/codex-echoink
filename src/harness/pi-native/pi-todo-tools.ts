import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopUtil } from "../../platform/desktop-runtime";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolCallEvent, type ToolDefinition, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { EchoInkTodoStore, TodoInput, TodoReadSnapshot } from "../../home/todo-store";
import type { ParsedTodoRecord } from "../../home/todo-markdown";
import { resolveTodoProject, serializeTodoProject, type TodoProject } from "../../home/todo-projects";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import type { PiWorkspaceAccess } from "./pi-workspace-access";
import type { FileDomainReceiptStore } from "./domain-receipt-store";
import { canonicalJsonStringify, normalizeJsonValue, type ApprovalOperationContract, type FileApprovalTicketStore, type JsonValue, type WriteToolAuthorizationContext } from "./tool-authorization";
import { EchoInkVaultToolEgressPolicy, secureVaultToolResult } from "./vault-tool-result-safety";
import { isPiTodoTool, normalizeTodoToolRequest, PI_TODO_TOOL_IDS, type PiTodoToolId, type PiTodoWriteToolId, type TodoToolFields } from "./todo-tool-policy";

const { createHash } = getDesktopCrypto();
const { isDeepStrictEqual } = getDesktopUtil();
export { PI_TODO_TOOL_IDS, type PiTodoToolId } from "./todo-tool-policy";

interface RunIdentity { vaultId: string; conversationId: string; piSessionId: string; productRunId: string }
export interface TodoApprovalInput extends RunIdentity {
  requestId: string; toolCallId: string; toolId: PiTodoWriteToolId; target: JsonValue; preview: JsonValue; signal: AbortSignal | undefined;
}
export interface PiTodoToolPort {
  /** The product's existing store; never initialize/reload it on an Agent read. */
  store: Pick<EchoInkTodoStore, "readOnlySnapshot" | "addTodo" | "updateTodo">;
  projects(): readonly TodoProject[];
}
export interface PiTodoSecurityOptions {
  assertToolAllowed(toolName: string, args: Readonly<Record<string, unknown>>, resolvedTarget?: unknown, currentOperation?: Readonly<{ productRunId: string; toolCallId: string }>): Promise<void>;
  currentAccess?: () => PiWorkspaceAccess | null | undefined;
  currentRunIdentity?: () => RunIdentity;
  currentUserEntry?: () => { entryId: string; text: string };
  approvals?: FileApprovalTicketStore;
  receipts?: FileDomainReceiptStore;
  confirmation?: { confirm(input: TodoApprovalInput): Promise<boolean> };
  userId?: string; deviceId?: string;
}
interface PreparedTodoWrite {
  snapshot: TodoReadSnapshot;
  record?: ParsedTodoRecord;
  input: TodoInput;
  projectPath?: string;
  target: JsonValue;
  preview: JsonValue;
  argumentsSha256: string;
}
interface TodoCall {
  tool: PiTodoToolId;
  input: Record<string, unknown>;
  state: "authorized" | "consumed" | "result_ready";
  prepared?: PreparedTodoWrite;
  identity?: RunIdentity;
  authorization?: Readonly<WriteToolAuthorizationContext>;
  result?: Record<string, unknown>;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(canonicalJsonStringify(normalizeJsonValue(value))).digest("hex"); }
function view(record: ParsedTodoRecord) {
  return { id: record.id, title: record.title, people: record.people, dueDate: record.dueDate, dueTime: record.dueTime ?? "", categoryName: record.categoryName, project: record.project ?? "", done: record.done };
}
function errorCode(error: unknown): string { return error instanceof Error ? error.message : "todo_failed"; }
function noEffectConflict(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && ["todo_source_changed", "todo_record_changed"].includes(String(error.code)); }
function retryIntent(text: string): boolean { return /重试|再执行|继续(?:刚才|之前|上次)|retry|try again/iu.test(text); }

/** Single-consume approval and durable P4 receipts around the same Markdown-backed store. */
export class PiTodoToolSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = PI_TODO_TOOL_IDS[0];
  readonly toolNames = PI_TODO_TOOL_IDS;
  private port?: PiTodoToolPort;
  private readonly seen = new Set<string>();
  private readonly calls = new Map<string, TodoCall>();
  constructor(private readonly options: PiTodoSecurityOptions) {}
  bindPort(port: PiTodoToolPort): void {
    if (this.port && this.port !== port) throw new Error("todo_port_already_bound");
    this.port = port;
  }
  private currentIdentity(): RunIdentity | undefined {
    const identity = this.options.currentRunIdentity?.();
    // Production execution contexts also carry user text and transient fields.
    // Only the four stable identity fields belong in strict approval contracts.
    return identity ? { vaultId: identity.vaultId, conversationId: identity.conversationId, piSessionId: identity.piSessionId, productRunId: identity.productRunId } : undefined;
  }
  private assertWriteAccess(): void {
    const access = this.options.currentAccess?.();
    if (!access || access.mode === "plan" || access.permission === "read-only") throw new Error("tool_policy_blocked");
  }
  private async prepare(tool: PiTodoWriteToolId, input: Record<string, unknown>, id: string): Promise<PreparedTodoWrite> {
    const snapshot = await this.port!.store.readOnlySnapshot();
    const record = tool === "todo_add" ? undefined : snapshot.records.find(item => item.id === input.id);
    if (tool !== "todo_add" && (!record || !record.id)) throw new Error("todo_target_not_found");
    if (record && snapshot.records.filter(item => item.id === record.id).length !== 1) throw new Error("todo_id_ambiguous");
    const fields: TodoToolFields = tool === "todo_add" ? { ...input } : tool === "todo_update" ? { ...input.patch as TodoToolFields } : {};
    let projectPath: string | undefined;
    if (fields.project !== undefined) {
      const projects = this.port!.projects();
      const selected = resolveTodoProject(fields.project, projects);
      if (selected.status !== "none" && selected.status !== "resolved") throw new Error(`todo_project_${selected.status}`);
      projectPath = selected.project?.path ?? "";
      fields.project = serializeTodoProject(projectPath, projects);
    }
    if (fields.dueTime && !(fields.dueDate ?? record?.dueDate)) throw new Error("todo_due_date_required");
    if (fields.dueDate === "") fields.dueTime = "";
    const next: TodoInput = tool === "todo_complete" ? { title: record!.title, done: input.done === true }
      : tool === "todo_add" ? { ...fields, title: String(fields.title), id, done: false }
        : { ...fields, title: fields.title ?? record!.title };
    const before = record ? view(record) : null;
    const after = { ...(before ?? { id, people: "", dueDate: "", dueTime: "", categoryName: "", project: "", done: false }), ...next };
    const { id: _generatedId, ...effectInput } = next;
    return { snapshot, record, input: next, projectPath, target: normalizeJsonValue({ relativePath: snapshot.sourcePath, todoId: record?.id ?? id }),
      preview: normalizeJsonValue({ domain: "todos", action: tool, relativePath: snapshot.sourcePath, before, after }),
      argumentsSha256: fingerprint(tool === "todo_add" ? effectInput : { id: record!.id, patch: next }) };
  }
  async handleToolCall(event: ToolCallEvent, signal?: AbortSignal) {
    if (this.seen.has(event.toolCallId)) return { block: true as const, reason: "authorization_failed" };
    this.seen.add(event.toolCallId);
    try {
      if (!this.port || !isPiTodoTool(event.toolName)) throw new Error("authorization_failed");
      if (signal?.aborted) throw new Error("approval_cancelled");
      const tool = event.toolName;
      const input = normalizeTodoToolRequest(tool, event.input);
      const identity = this.currentIdentity();
      const operation = identity ? { productRunId: identity.productRunId, toolCallId: event.toolCallId } : undefined;
      await this.options.assertToolAllowed(tool, input, undefined, operation);
      const call: TodoCall = { tool, input, state: "authorized", identity };
      if (tool !== "todo_query") {
        this.assertWriteAccess();
        const { approvals, receipts, confirmation, userId, deviceId } = this.options;
        if (!approvals || !receipts || !confirmation || !identity || !userId || !deviceId || identity.vaultId !== approvals.vaultId) throw new Error("authorization_failed");
        const entry = this.options.currentUserEntry?.();
        if (!entry?.entryId) throw new Error("authorization_failed");
        call.prepared = await this.prepare(tool, input, `todo_${fingerprint({ ...identity, toolCallId: event.toolCallId }).slice(0, 24)}`);
        await this.options.assertToolAllowed(tool, input, call.prepared.target, operation);
        for (const row of (await receipts.listUiViews({ conversationId: identity.conversationId })).filter(row => row.toolId === tool)) {
          const prior = await receipts.readOperation(row.operationIdentity);
          const version = prior?.targetVersion as Record<string, JsonValue> | null;
          const sameIntent = !!entry?.entryId && version?.intentEntryId === entry.entryId || prior?.productRunId === identity.productRunId || retryIntent(entry?.text ?? "");
          if (prior && version?.argumentsSha256 === call.prepared.argumentsSha256 && sameIntent && prior.effectState !== "authorized" && (!row.receipt || row.receipt.status === "uncertain" || row.receipt.status === "completed")) {
            throw new Error(row.receipt?.status === "completed" ? "todo_operation_already_completed_query" : "todo_previous_result_uncertain_do_not_retry");
          }
        }
        const contract: ApprovalOperationContract = { ...identity, toolCallId: event.toolCallId, toolId: tool, userId, deviceId,
          toolVersion: "todo-tools-v1", policyVersion: "todo-policy-v1", normalizedArguments: normalizeJsonValue(input), resolvedTarget: call.prepared.target,
          targetVersion: normalizeJsonValue({ beforeVersion: call.prepared.snapshot.contentVersion, argumentsSha256: call.prepared.argumentsSha256, intentEntryId: entry?.entryId ?? null }), preview: call.prepared.preview };
        const issuedAt = Date.now();
        const ticket = await approvals.issue({ ...contract, issuedAt, expiresAt: issuedAt + 300_000 });
        let accepted: boolean;
        try { accepted = await confirmation.confirm({ ...identity, requestId: ticket.ticketId, toolCallId: event.toolCallId, toolId: tool, target: ticket.resolvedTarget, preview: ticket.preview, signal }); }
        catch { await approvals.resolve({ ticketId: ticket.ticketId, productRunId: identity.productRunId, toolCallId: event.toolCallId, resolution: "cancelled" }); throw new Error("approval_cancelled"); }
        if (!accepted || signal?.aborted) {
          const resolution = signal?.aborted ? "cancelled" : "denied";
          await approvals.resolve({ ticketId: ticket.ticketId, productRunId: identity.productRunId, toolCallId: event.toolCallId, resolution });
          throw new Error(resolution === "cancelled" ? "approval_cancelled" : "approval_denied");
        }
        call.authorization = await approvals.consume({ ticketId: ticket.ticketId, operationIdentity: ticket.operationIdentity, contract });
        await receipts.beginAuthorizedOperation(call.authorization);
      }
      this.calls.set(event.toolCallId, call);
    } catch (error) {
      const reason = errorCode(error);
      return { block: true as const, reason: /^(?:todo_|approval_|authorization_failed|agent_capability_)/u.test(reason) ? reason : "tool_policy_blocked" };
    }
  }
  private async query(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = input.query, requestedProject = input.project;
    if ((query !== undefined && typeof query !== "string") || (requestedProject !== undefined && typeof requestedProject !== "string")) throw new Error("todo_invalid_request");
    const snapshot = await this.port!.store.readOnlySnapshot();
    const projects = this.port!.projects();
    const needle = (query ?? "").toLocaleLowerCase();
    const project = requestedProject === undefined ? undefined : resolveTodoProject(requestedProject, projects);
    const records = snapshot.records.filter(record => (!input.id || record.id === input.id)
      && (input.status === "all" || record.done === (input.status === "completed"))
      && (!needle || record.title.toLocaleLowerCase().includes(needle))
      && (project === undefined || project.status === "none" ? project === undefined || !record.project
        : project.status === "resolved" ? resolveTodoProject(record.project, projects).project?.path === project.project?.path : record.project === input.project));
    const identity = this.currentIdentity();
    const operations = this.options.receipts && identity ? (await this.options.receipts.listUiViews({ conversationId: identity.conversationId }))
      .filter(row => isPiTodoTool(row.toolId))
      .sort((a, b) => (b.receipt?.recordedAt ?? Number.MAX_SAFE_INTEGER) - (a.receipt?.recordedAt ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 20).map(row => ({ operationIdentity: row.operationIdentity, tool: row.toolId, status: row.receipt?.status ?? (row.effectState === "authorized" ? "not_started" : "uncertain"), target: row.resolvedTarget, readbackVerified: row.receipt?.readback.readbackVerified === true })) : [];
    return { status: "completed", sourcePath: snapshot.sourcePath, exists: snapshot.exists, contentVersion: snapshot.contentVersion, warnings: snapshot.warnings,
      total: records.length, truncated: records.length > Number(input.limit), todos: records.slice(0, Number(input.limit)).map(record => ({ ...view(record), editable: !!record.id, projectStatus: resolveTodoProject(record.project, projects).status })),
      projects: projects.map(project => ({ path: project.path, value: project.value, label: project.label })), operations };
  }
  async execute(id: string, tool: PiTodoToolId, value: unknown, signal?: AbortSignal): Promise<void> {
    const call = this.calls.get(id);
    if (!call || call.state !== "authorized" || call.tool !== tool || !isDeepStrictEqual(call.input, normalizeTodoToolRequest(tool, value))) throw new Error("todo_authorization_failed");
    call.state = "consumed";
    let started = false;
    let result: Record<string, unknown>;
    try {
      if (signal?.aborted) throw new Error("approval_cancelled");
      if (call.identity && !isDeepStrictEqual(call.identity, this.currentIdentity())) throw new Error("todo_authorization_failed");
      const operation = call.identity ? { productRunId: call.identity.productRunId, toolCallId: id } : undefined;
      await this.options.assertToolAllowed(tool, call.input, call.prepared?.target, operation);
      if (tool === "todo_query") result = await this.query(call.input);
      else {
        this.assertWriteAccess();
        const prepared = call.prepared!;
        if (prepared.projectPath !== undefined && serializeTodoProject(prepared.projectPath, this.port!.projects()) !== prepared.input.project) throw new Error("todo_project_changed");
        const current = await this.port!.store.readOnlySnapshot();
        if (current.contentVersion !== prepared.snapshot.contentVersion) throw new Error("todo_source_changed");
        await this.options.assertToolAllowed(tool, call.input, prepared.target, operation);
        this.assertWriteAccess();
        if (signal?.aborted) throw new Error("approval_cancelled");
        await this.options.receipts!.markEffectStarted(call.authorization!.operationIdentity);
        started = true;
        if (tool === "todo_add") await this.port!.store.addTodo(prepared.input, prepared.snapshot.contentVersion);
        else await this.port!.store.updateTodo(prepared.record!, prepared.input, prepared.snapshot.contentVersion);
        const after = await this.port!.store.readOnlySnapshot();
        const expected = (prepared.preview as { after: JsonValue }).after;
        const records = after.records.filter(record => record.id === (prepared.record?.id ?? prepared.input.id));
        const verified = records.length === 1 && isDeepStrictEqual(view(records[0]), expected);
        result = { status: verified ? "completed" : "uncertain", readbackVerified: verified, observedTargetVersion: after.contentVersion, ...(verified ? { todo: view(records[0]) } : { reason: "todo_result_uncertain_query_original_operation" }) };
      }
    } catch (error) {
      const noEffectVerified = noEffectConflict(error);
      result = { status: started && !noEffectVerified ? "uncertain" : signal?.aborted ? "cancelled" : "failed", reason: noEffectVerified ? String((error as { code: string }).code) : errorCode(error), readbackVerified: false };
    }
    if (call.authorization) {
      try {
        if (started) await this.options.receipts!.markEffectCompleted(call.authorization.operationIdentity);
        await this.options.receipts!.persistReceipt({ operationIdentity: call.authorization.operationIdentity,
          status: result.status as "completed" | "failed" | "cancelled" | "uncertain", safeSummary: normalizeJsonValue({ source: "echoink-todos", action: tool, status: result.status, readbackVerified: result.readbackVerified === true }),
          readback: { checkedAt: Date.now(), readbackVerified: result.readbackVerified === true, observedTargetVersion: typeof result.observedTargetVersion === "string" ? result.observedTargetVersion : null, safeSummary: result.readbackVerified ? "Todo readback verified" : "Result not verified; query before retrying" } });
        result.operationIdentity = call.authorization.operationIdentity;
      } catch { result = { status: "uncertain", reason: "todo_receipt_uncertain_query_original_operation", readbackVerified: false, operationIdentity: call.authorization.operationIdentity }; }
    }
    call.result = result;
    call.state = "result_ready";
  }
  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId); this.calls.delete(event.toolCallId);
    const valid = call?.tool === event.toolName && call.state === "result_ready";
    const secured = await secureVaultToolResult({ toolId: event.toolName, effectType: call?.tool === "todo_query" ? "read" : "user_write", egressPolicy: "echoink-configured-provider-v1", value: valid ? call.result : { error: "todo_authorization_failed" }, sizeLimitBytes: 32_000, egress: new EchoInkVaultToolEgressPolicy() });
    return { content: [{ type: "text" as const, text: secured.text }], details: { source: "echoink-todos", toolCallId: event.toolCallId, status: call?.result?.status, readbackVerified: call?.result?.readbackVerified === true, truncated: secured.truncated }, isError: !valid || call?.result?.status !== "completed" || secured.truncated };
  }
}

export function createPiTodoToolDefinitions(port: PiTodoToolPort, security: PiTodoToolSecurity): ToolDefinition[] {
  security.bindPort(port);
  const fields = { title: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })), ...Object.fromEntries(["people", "dueDate", "dueTime", "categoryName", "project"].map(key => [key, Type.Optional(Type.String({ maxLength: 500 }))])) };
  const id = Type.String({ minLength: 1, maxLength: 200 });
  const definitions: Array<{ name: PiTodoToolId; label: string; description: string; parameters: ReturnType<typeof Type.Object> }> = [
    { name: "todo_query" as const, label: "查看待办", description: "只读查询 EchoInk 待办源文件，返回稳定ID、有效项目选项和本对话最近20条操作回执。未完成为open，已完成为completed；project空串表示不属于项目，不传则全部。无ID手写记录只读，需在待办页初始化后才可修改；不补ID、不迁移。", parameters: Type.Object({ id: Type.Optional(id), status: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("open"), Type.Literal("completed")])), project: Type.Optional(Type.String()), query: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }) },
    { name: "todo_add" as const, label: "新增待办", description: "新增一条正式待办，沿原写入确认和回执。先todo_query读取有效项目选项；project只选已有项目path或value，空串不关联。日期YYYY-MM-DD、时间HH:mm。拒绝确认不落盘；结果不确定或已经完成时先查询原回执，不能再次新增。", parameters: Type.Object({ ...fields, title: Type.String({ minLength: 1, maxLength: 1_000 }) }, { additionalProperties: false }) },
    { name: "todo_update" as const, label: "修改待办", description: "按todo_query返回的稳定ID修改标题、人员、截止日期/时间、分类或项目。patch只传要改的字段，空串清除；不传project保留原失效关联。确认后源文件变化则拒绝覆盖，重新读取后再处理。", parameters: Type.Object({ id, patch: Type.Object(fields, { additionalProperties: false }) }, { additionalProperties: false }) },
    { name: "todo_complete" as const, label: "完成待办", description: "按稳定ID完成指定待办；done=false取消完成。沿同一TodoStore、确认、完成历史与正式回执。不得从标题猜ID，不批量猜测目标。", parameters: Type.Object({ id, done: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) }
  ];
  return definitions.map(definition => defineTool({ ...definition, execute: async (id, args, signal) => { await security.execute(id, definition.name, args, signal); return { content: [{ type: "text" as const, text: "todo_result_pending_safety" }], details: {} }; } }));
}
