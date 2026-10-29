import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createWorkspaceTools } from "../../workspace/tools";
import { WORKSPACE_MAX_BYTES, WorkspaceError, workspacePath, type WorkspaceGuard, type WorkspaceService } from "../../workspace/service";
import type { PiKnowledgeRunIdentity } from "./contracts";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy, secureVaultToolResult, VAULT_READ_TOOL_RESULT_LIMIT_BYTES, VAULT_WRITE_TOOL_RESULT_LIMIT_BYTES } from "./vault-tool-result-safety";

export const PI_WORKSPACE_TOOL_IDS = ["workspace_read", "workspace_create", "workspace_update"] as const;
type PiWorkspaceToolId = typeof PI_WORKSPACE_TOOL_IDS[number];
interface WorkspaceCall {
  tool: PiWorkspaceToolId; args: Readonly<Record<string, unknown>>; identity: string;
  state: "authorized" | "consumed" | "ready";
  signal?: AbortSignal;
  result?: Readonly<Record<string, unknown>>; error?: string;
}
export interface PiWorkspaceToolSecurityOptions {
  service: WorkspaceService;
  currentRunIdentity(): PiKnowledgeRunIdentity;
  assertToolAllowed(tool: string, args: Readonly<Record<string, unknown>>): Promise<void>;
  /** The service rechecks live Agent/expert/permission state across every file boundary. */
  guard: WorkspaceGuard;
}
function isTool(value: string): value is PiWorkspaceToolId { return PI_WORKSPACE_TOOL_IDS.some(tool => tool === value); }
function normalize(tool: PiWorkspaceToolId, value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_invalid_arguments");
  const data = value as Record<string, unknown>, keys = tool === "workspace_read" ? ["path"] : tool === "workspace_create" ? ["path", "content"] : ["path", "content", "expectedRevision"];
  if (Object.keys(data).some(key => !keys.includes(key)) || typeof data.path !== "string") throw new Error("workspace_invalid_arguments");
  const path = workspacePath(data.path);
  if (tool === "workspace_read") return Object.freeze({ path });
  if (typeof data.content !== "string" || data.content.includes("\0") || new TextEncoder().encode(data.content).length > WORKSPACE_MAX_BYTES) throw new Error("workspace_invalid_arguments");
  if (tool === "workspace_create") return Object.freeze({ path, content: data.content });
  if (typeof data.expectedRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(data.expectedRevision)) throw new Error("workspace_invalid_arguments");
  return Object.freeze({ path, content: data.content, expectedRevision: data.expectedRevision });
}
function failure(error: unknown): string {
  if (error instanceof WorkspaceError) return `workspace_${error.code}`;
  const message = error instanceof Error ? error.message : "";
  return /^(?:agent_capability_[a-z0-9_]+|workspace_[a-z0-9_]+|tool_policy_blocked|authorization_failed|approval_cancelled)$/u.test(message) ? message : "workspace_operation_failed";
}

/** One-shot admission and trusted result egress for the three explicit workspace tools. */
export class PiWorkspaceToolSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = "workspace_read";
  readonly toolNames = PI_WORKSPACE_TOOL_IDS;
  private readonly seen = new Set<string>();
  private readonly calls = new Map<string, WorkspaceCall>();
  private readonly tools: AgentTool[];
  constructor(private readonly options: PiWorkspaceToolSecurityOptions) {
    this.tools = createWorkspaceTools(options.service, { guard: options.guard });
  }
  private identity(): string {
    const { vaultId, conversationId, piSessionId, productRunId } = this.options.currentRunIdentity();
    return JSON.stringify({ vaultId, conversationId, piSessionId, productRunId });
  }
  private async assertCurrent(call: WorkspaceCall, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || call.signal?.aborted) throw new Error("approval_cancelled");
    if (call.identity !== this.identity()) throw new Error("workspace_authorization_failed");
    await this.options.assertToolAllowed(call.tool, call.args);
    if (signal?.aborted || call.signal?.aborted || call.identity !== this.identity()) throw new Error("workspace_authorization_failed");
  }
  async handleToolCall(event: ToolCallEvent, signal?: AbortSignal) {
    try {
      if (!isTool(event.toolName) || this.seen.has(event.toolCallId)) throw new Error("workspace_authorization_failed");
      this.seen.add(event.toolCallId);
      const call: WorkspaceCall = { tool: event.toolName, args: normalize(event.toolName, event.input), identity: this.identity(), state: "authorized", signal };
      await this.assertCurrent(call, signal);
      this.calls.set(event.toolCallId, call);
    } catch (error) { return { block: true as const, reason: failure(error) }; }
  }
  async execute(id: string, tool: string, value: unknown, signal?: AbortSignal): Promise<void> {
    const call = this.calls.get(id);
    if (!call || !isTool(tool) || call.tool !== tool || call.state !== "authorized" || JSON.stringify(call.args) !== JSON.stringify(normalize(tool, value))) throw new Error("workspace_authorization_failed");
    call.state = "consumed";
    try {
      await this.assertCurrent(call, signal);
      const definition = this.tools.find(item => item.name === tool);
      if (!definition) throw new Error("workspace_authorization_failed");
      const result = await definition.execute(id, call.args, signal);
      await this.assertCurrent(call, signal);
      if (!result.details || typeof result.details !== "object" || Array.isArray(result.details)) throw new Error("workspace_result_invalid");
      const details = result.details as Record<string, unknown>;
      if (details.path !== call.args.path || typeof details.contentRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(details.contentRevision)
        || tool === "workspace_read" && typeof details.content !== "string"
        || details.previewPath !== undefined && details.previewPath !== details.path) throw new Error("workspace_result_invalid");
      // Keep only the service's exact-target result, never model-authored event details.
      call.result = Object.freeze({ path: details.path, contentRevision: details.contentRevision,
        ...(tool === "workspace_read" ? { content: details.content } : {}),
        ...(details.previewPath === details.path ? { previewPath: details.previewPath } : {}) });
    } catch (error) { call.error = failure(error); }
    call.state = "ready";
  }
  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId); this.calls.delete(event.toolCallId);
    const rejected = (reason = "workspace_authorization_failed") => ({ content: [{ type: "text" as const, text: reason }],
      details: { source: "echoink-workspace", toolCallId: event.toolCallId, status: "failed" }, isError: true });
    if (!call || call.tool !== event.toolName || call.state !== "ready") return rejected();
    try {
      await this.assertCurrent(call);
      if (call.error || !call.result || event.isError) return rejected(call.error);
      const policy = new EchoInkVaultToolEgressPolicy();
      const secured = await secureVaultToolResult({ toolId: call.tool, effectType: call.tool === "workspace_read" ? "read" : "user_write",
        egressPolicy: "echoink-configured-provider-v1", value: call.result,
        sizeLimitBytes: call.tool === "workspace_read" ? VAULT_READ_TOOL_RESULT_LIMIT_BYTES : VAULT_WRITE_TOOL_RESULT_LIMIT_BYTES,
        egress: { assertAllowed: async context => { await this.assertCurrent(call); policy.assertAllowed(context); } } });
      return { content: [{ type: "text" as const, text: secured.text }], details: { source: "echoink-workspace", toolCallId: event.toolCallId,
        status: "completed", path: call.result.path, contentRevision: call.result.contentRevision,
        ...(call.result.previewPath ? { previewPath: call.result.previewPath } : {}), truncated: secured.truncated }, isError: secured.truncated };
    } catch (error) { return rejected(failure(error)); }
  }
  definitions(): AgentTool[] {
    return this.tools.map(tool => ({ ...tool, execute: async (id, args, signal) => {
      await this.execute(id, tool.name, args, signal);
      return { content: [{ type: "text" as const, text: "workspace_result_pending_safety" }], details: {} };
    } }));
  }
}
export function createPiWorkspaceToolDefinitions(security: PiWorkspaceToolSecurity): AgentTool[] { return security.definitions(); }
