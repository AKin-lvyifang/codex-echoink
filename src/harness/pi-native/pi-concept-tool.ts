import { defineTool, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { exploreConcept, normalizeExploreConceptArguments, type ConceptExplorerPort, type ConceptExploration } from "../../knowledge-base/concept-explorer";
import { secureVaultToolResult } from "./vault-tool-result-safety";
import type { PiVaultAdditionalToolSecurityPort } from "./pi-vault-tool-security-extension";
import type { PiKnowledgeRunIdentity } from "./contracts";

interface ConceptCall { identity: string; args: string; scope: string; state: "authorized" | "ready"; result?: ConceptExploration; failed?: boolean }
export class PiConceptToolSecurity implements PiVaultAdditionalToolSecurityPort {
  readonly toolName = "explore_concept";
  private readonly calls = new Map<string, ConceptCall>();
  constructor(private readonly options: {
    port: ConceptExplorerPort;
    identity(): PiKnowledgeRunIdentity;
    assertAllowed(args: Record<string, unknown>): Promise<void>;
    canMemory(): boolean | Promise<boolean>;
    searchMemory(query: string): Promise<unknown>;
    scopeKey(): string;
  }) {}
  async handleToolCall(event: ToolCallEvent) {
    try {
      if (this.calls.has(event.toolCallId)) throw new Error("replayed_call");
      const args = normalizeExploreConceptArguments(event.input);
      await this.options.assertAllowed({ ...args });
      this.calls.set(event.toolCallId, { identity: JSON.stringify(this.options.identity()), args: JSON.stringify(args), scope: this.options.scopeKey(), state: "authorized" });
    } catch { return { block: true as const, reason: "tool_policy_blocked" }; }
  }
  async execute(id: string, input: unknown) {
    const args = normalizeExploreConceptArguments(input), call = this.calls.get(id);
    if (!call || call.state !== "authorized" || call.args !== JSON.stringify(args) || call.identity !== JSON.stringify(this.options.identity())) throw new Error("concept_authorization_failed");
    // Consume before awaiting so replayed executions cannot run a second read.
    call.state = "ready";
    const scope = call.scope;
    try {
      if (scope !== this.options.scopeKey()) throw new Error("knowledge_scope_changed");
      await this.options.assertAllowed({ ...args });
      const memoryAtStart = await this.options.canMemory();
      const result = await exploreConcept(this.options.port, args);
      if (memoryAtStart && await this.options.canMemory()) {
        try { result.data.relatedMemories = await this.options.searchMemory(args.name); } catch { result.data.memoryStatus = "unavailable"; }
      }
      if (scope !== this.options.scopeKey()) throw new Error("knowledge_scope_changed");
      call.result = result;
    } catch { call.failed = true; }
  }
  async handleToolResult(event: ToolResultEvent) {
    const call = this.calls.get(event.toolCallId);
    this.calls.delete(event.toolCallId);
    const rejected = () => ({ content: [{ type: "text" as const, text: "concept_read_unavailable" }], details: { source: "echoink-knowledge", status: "failed" }, isError: true });
    try {
      if (!call?.result || call.failed || event.isError || call.identity !== JSON.stringify(this.options.identity())) return rejected();
      const args = JSON.parse(call.args) as Record<string, unknown>;
      await this.options.assertAllowed(args);
      const scope = call.scope;
      if (scope !== this.options.scopeKey()) return rejected();
      if (!await this.options.canMemory()) { delete call.result.data.relatedMemories; delete call.result.data.memoryStatus; }
      const secured = await secureVaultToolResult({ toolId: this.toolName, effectType: "read", egressPolicy: "echoink-configured-provider-v1", value: { trust: "untrusted-background", ...call.result.data }, sizeLimitBytes: 32_000,
        egress: { assertAllowed: async () => {
          await this.options.assertAllowed(args);
          if (scope !== this.options.scopeKey()) throw new Error("knowledge_scope_changed");
          if (call.result?.data.relatedMemories && !await this.options.canMemory()) throw new Error("memory_access_revoked");
        } } });
      if (secured.truncated) return rejected();
      return { content: [{ type: "text" as const, text: secured.text }], details: { source: "echoink-knowledge", type: "echoink.knowledge-references.v1", schemaVersion: 1,
        status: "completed", truncated: false, references: call.result.references, toolCallId: event.toolCallId }, isError: false };
    } catch { return rejected(); }
  }
}
export function createPiConceptTool(security: PiConceptToolSecurity) {
  return defineTool({ name: "explore_concept", label: "查概念", description: "按概念名或别名查原文摘录、出链与反链（cursor 分页）、原始出处；重名时指定候选 vaultRelativePath。记忆允许时附相关记忆；链接不表示观点一致，无匹配再用 knowledge_search。",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }), vaultRelativePath: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()), candidateOffset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
    execute: async (id, args) => { await security.execute(id, args); return { content: [{ type: "text", text: "concept_result_pending_safety" }], details: {} }; } });
}
