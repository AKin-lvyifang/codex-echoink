import type { KnowledgeAgentSearchRequest, KnowledgeAgentSearchResult } from "../knowledge-base/knowledge-agent-index";
import { exploreConcept, normalizeExploreConceptArguments, type ConceptExplorerPort } from "../knowledge-base/concept-explorer";
import { normalizePiKnowledgeReadToolArguments, readToolResult, searchToolResult, toolResultForProvider } from "../harness/pi-native/pi-knowledge-read-tools";
import { secureVaultToolResult, VAULT_READ_TOOL_RESULT_LIMIT_BYTES } from "../harness/pi-native/vault-tool-result-safety";
import type { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import type { PersonalMemoryRuntimeContext } from "../harness/memory/personal-memory-contracts";
import type { PiKnowledgeReference } from "../harness/pi-native/contracts";

export const ECHOINK_MCP_TOOL_NAMES = ["get_user_profile", "search_memory", "read_memory", "explore_concept", "search_knowledge", "read_note"] as const;
export type EchoInkMcpToolName = typeof ECHOINK_MCP_TOOL_NAMES[number];
export interface McpReadAccess { knowledge: boolean; memory: boolean; pro: boolean; enabled: boolean }
export interface McpReadPorts {
  knowledge: ConceptExplorerPort & { search(input: KnowledgeAgentSearchRequest): Promise<KnowledgeAgentSearchResult>; scopeKey(): string; allowsPath(path: string): boolean };
  memory(): Promise<{ repository: PersonalMemoryRepository; vaultId: string }>;
  access(): McpReadAccess;
}
const string = { type: "string", minLength: 1, maxLength: 1024 };
const page = { type: "integer", minimum: 1, maximum: 20 };
export const ECHOINK_MCP_TOOLS = [
  { name: "get_user_profile", description: "Read the current user profile and bounded memory navigation (not an importance ranking).", properties: {}, required: [] },
  { name: "search_memory", description: "Search current personal memories for this task; an empty search is not proof of absence.", properties: { query: string, limit: page, cursor: string }, required: ["query"] },
  { name: "read_memory", description: "Read a current memory by ID, following nextOffset for longer records.", properties: { id: string, offset: { type: "integer", minimum: 0 } }, required: ["id"] },
  { name: "explore_concept", description: "Exact concept title or alias: bounded original excerpt, paged outgoing/back links, raw sources and optionally related memories. Resolve ambiguous candidates by vaultRelativePath. Links do not imply agreement.", properties: { name: { ...string, maxLength: 256 }, vaultRelativePath: string, cursor: string, candidateOffset: { type: "integer", minimum: 0 } }, required: ["name"] },
  { name: "search_knowledge", description: "Search the current Knowledge scope. Returns note paths, content revisions and bounded original excerpts; use read_note to read further.", properties: { query: string, limit: page, cursor: string }, required: ["query"] },
  { name: "read_note", description: "Read a note by path and expectedContentRevision, optionally by heading/block anchor or line/column range. Returns delivered range and continuation. On source_changed refresh the version.", properties: { vaultRelativePath: string, expectedContentRevision: string, anchor: string,
    lineStart: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 80 }, columnStart: { type: "integer", minimum: 0 }, columnEnd: { type: "integer", minimum: 0 } }, required: ["vaultRelativePath", "expectedContentRevision"] }
].map(tool => ({ name: tool.name as EchoInkMcpToolName, description: tool.description, inputSchema: { type: "object" as const, properties: tool.properties, required: tool.required, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));

export function mcpToolGrant(name: string): "knowledge" | "memory" | null {
  return ["get_user_profile", "search_memory", "read_memory"].includes(name) ? "memory"
    : ["explore_concept", "search_knowledge", "read_note"].includes(name) ? "knowledge" : null;
}
export function assertMcpReadAccess(access: McpReadAccess, name: string): void {
  if (!access.enabled) throw Object.assign(new Error("Service disabled"), { code: "service_disabled" });
  if (!access.pro) throw Object.assign(new Error("Active PRO membership required"), { code: "membership_required" });
  const grant = mcpToolGrant(name);
  if (!grant || !access[grant]) throw Object.assign(new Error("Read permission denied"), { code: "permission_denied" });
}
export interface McpToolEnvelope {
  requestId: string;
  ok: boolean;
  trust: "untrusted-background";
  sourceVersions: readonly unknown[];
  deliveredRanges: readonly unknown[];
  truncated: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}
export class EchoInkMcpReadTools {
  constructor(private readonly ports: McpReadPorts) {}
  list() { const access = this.ports.access(); return ECHOINK_MCP_TOOLS.filter(tool => { const grant = mcpToolGrant(tool.name); return access.enabled && access.pro && grant && access[grant]; }); }

  async call(name: string, raw: unknown, requestId: string, assertRequest: () => void = () => {}): Promise<McpToolEnvelope> {
    const base = { requestId, trust: "untrusted-background" as const, sourceVersions: [] as readonly unknown[], deliveredRanges: [] as readonly unknown[], truncated: false };
    try {
      assertRequest(); assertMcpReadAccess(this.ports.access(), name);
      const args = validateArguments(name, raw);
      const scope = this.ports.knowledge.scopeKey();
      const memoryAtStart = this.ports.access().memory;
      let data: Record<string, unknown>, references: readonly PiKnowledgeReference[] = [], sourceVersions: readonly unknown[] = [], deliveredRanges: readonly unknown[] = [], truncated = false;
      if (name === "search_knowledge") {
        const result = searchToolResult(await this.ports.knowledge.search(normalizePiKnowledgeReadToolArguments("knowledge_search", args)), 0);
        data = toolResultForProvider(result) as Record<string, unknown>;
        sourceVersions = result.hits.map(hit => ({ path: hit.vaultRelativePath, version: hit.contentRevision }));
        deliveredRanges = result.hits.filter(hit => hit.excerpt !== undefined).map(hit => ({ path: hit.vaultRelativePath, lineStart: hit.lineStart, lineEnd: hit.lineEnd, columnStart: hit.columnStart, columnEnd: hit.columnEnd }));
      } else if (name === "read_note") {
        const input = normalizePiKnowledgeReadToolArguments("knowledge_read", args);
        const result = readToolResult(await this.ports.knowledge.read(input), input);
        data = toolResultForProvider(result) as Record<string, unknown>; references = [result.reference];
      } else if (name === "explore_concept") {
        const result = await exploreConcept(this.ports.knowledge, normalizeExploreConceptArguments(args));
        data = result.data; references = result.references;
        sourceVersions = result.sources.map(source => ({ path: source.vaultRelativePath, version: source.contentRevision }));
        if (memoryAtStart && this.ports.access().memory) {
          try { const { repository, runtime } = await this.memoryRuntime(requestId); assertRequest();
            if (this.ports.access().memory) data.relatedMemories = await repository.search({ query: String(args.name), limit: 3 }, runtime, { maxResultChars: 1800 });
          } catch { data.memoryStatus = "unavailable"; }
        }
      } else {
        const { repository, runtime } = await this.memoryRuntime(requestId);
        assertMcpReadAccess(this.ports.access(), name); assertRequest();
        if (name === "get_user_profile") {
          const result = await repository.loadFixedContext({ memoryMode: "normal" });
          const profile = result.user ?? "", navigation = result.memory ?? "";
          data = { profile: profile.slice(0, 4000), memoryNavigation: navigation.slice(0, 4000), navigationMeaning: "按日期和类别限制条数的有限记忆导航，不是最重要记忆摘要。" };
          sourceVersions = [{ source: "personal-memory", version: result.revision }];
          deliveredRanges = [{ source: "profile", offset: 0, length: Math.min(profile.length, 4000), total: profile.length }, { source: "memoryNavigation", offset: 0, length: Math.min(navigation.length, 4000), total: navigation.length }];
          truncated = profile.length > 4000 || navigation.length > 4000;
        } else if (name === "search_memory") {
          const result = await repository.search({ query: String(args.query), limit: args.limit as number | undefined, cursor: args.cursor as string | undefined }, runtime, { maxResultChars: 6000 });
          data = { ...result }; sourceVersions = [{ source: "personal-memory", version: result.revision }];
          deliveredRanges = result.items.map(item => ({ id: item.id, excerpt: true }));
        } else {
          const result = await repository.read(String(args.id), runtime);
          const offset = args.offset === undefined ? 0 : Number(args.offset);
          if (offset > result.record.content.length) throw Object.assign(new Error("Offset out of range"), { code: "invalid_arguments" });
          const content = result.record.content.slice(offset, offset + 6000), hasMore = offset + content.length < result.record.content.length;
          data = { revision: result.revision, record: { ...result.record, content }, hasMore, ...(hasMore ? { nextOffset: offset + content.length } : {}) };
          sourceVersions = [{ id: result.record.id, version: result.record.revision }];
          deliveredRanges = [{ id: result.record.id, offset, length: content.length, total: result.record.content.length }]; truncated = hasMore;
        }
      }
      if (references.length) {
        sourceVersions = references.map(reference => ({ path: reference.vaultRelativePath, version: reference.contentRevision }));
        deliveredRanges = references.map(reference => ({ path: reference.vaultRelativePath, lineStart: reference.lineStart, lineEnd: reference.lineEnd, columnStart: reference.columnStart, columnEnd: reference.columnEnd }));
        truncated ||= references.some(reference => reference.hasMore);
      }
      const check = () => {
        assertRequest(); assertMcpReadAccess(this.ports.access(), name);
        if (mcpToolGrant(name) === "knowledge" && scope !== this.ports.knowledge.scopeKey()) throw Object.assign(new Error("Knowledge scope changed"), { code: "permission_changed" });
      };
      check();
      if (name === "explore_concept" && !this.ports.access().memory) { delete data.relatedMemories; delete data.memoryStatus; }
      const envelope = { ...base, ok: true, data, sourceVersions, deliveredRanges, truncated };
      const secured = await secureVaultToolResult({ toolId: name, effectType: "read", egressPolicy: "echoink-external-mcp-v1", value: envelope,
        sizeLimitBytes: VAULT_READ_TOOL_RESULT_LIMIT_BYTES, egress: { assertAllowed: check } });
      check();
      if (secured.truncated) return { ...base, ok: false, truncated: true, error: { code: "result_too_large", message: "Reduce the requested range or page size and retry." } };
      return JSON.parse(secured.text) as McpToolEnvelope;
    } catch (error) {
      const code = safeErrorCode(error);
      return { ...base, ok: false, error: { code, message: errorMessage(code) } };
    }
  }
  private async memoryRuntime(requestId: string) {
    const access = this.ports.access();
    if (!access.memory) throw Object.assign(new Error("Memory sharing disabled"), { code: "permission_denied" });
    const { repository, vaultId } = await this.ports.memory();
    const identity = `external-mcp:${requestId}`;
    const runtime: PersonalMemoryRuntimeContext = { vaultId, conversationId: identity, piSessionId: identity, productRunId: identity, userEntryId: identity, toolCallId: identity, memoryMode: "normal" };
    return { repository, runtime };
  }
}
function validateArguments(name: string, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid_arguments");
  const args = raw as Record<string, unknown>;
  const descriptor = ECHOINK_MCP_TOOLS.find(tool => tool.name === name);
  if (!descriptor || Object.keys(args).some(key => !(key in descriptor.inputSchema.properties))) throw new TypeError("invalid_arguments");
  for (const key of descriptor.inputSchema.required) if (!(key in args)) throw new TypeError("invalid_arguments");
  for (const [key, value] of Object.entries(args)) {
    const rule = (descriptor.inputSchema.properties as Record<string, { type: string; maxLength?: number; minimum?: number; maximum?: number }>)[key];
    if (rule.type === "string" ? typeof value !== "string" || !value.trim() || value.length > (rule.maxLength ?? 1024)
      : !Number.isSafeInteger(value) || Number(value) < (rule.minimum ?? 0) || Number(value) > (rule.maximum ?? Number.MAX_SAFE_INTEGER)) throw new TypeError("invalid_arguments");
  }
  return args;
}
function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof TypeError ? "invalid_arguments" : "read_failed";
  return ["service_disabled", "membership_required", "permission_denied", "permission_changed", "request_revoked", "invalid_arguments", "invalid_path", "source_changed", "not_found", "cursor_stale", "invalid_cursor", "unavailable", "no_memory", "revision_conflict"].includes(code) ? code : "read_failed";
}
function errorMessage(code: string): string {
  return code === "source_changed" ? "Source changed; search again for the current contentRevision."
    : code === "not_found" ? "本次读取未找到该条目。"
    : code === "membership_required" ? "Active EchoInk PRO membership required."
    : code === "invalid_arguments" ? "Invalid tool arguments; use the published schema."
    : `EchoInk read unavailable (${code}).`;
}
