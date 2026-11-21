import type { KnowledgeAgentSearchRequest, KnowledgeAgentSearchResult } from "../knowledge-base/knowledge-agent-index";
import { exploreConcept, normalizeExploreConceptArguments, type ConceptExplorerPort } from "../knowledge-base/concept-explorer";
import { normalizePiKnowledgeReadToolArguments, readToolResult, searchToolResult, toolResultForProvider } from "../harness/pi-native/pi-knowledge-read-tools";
import { secureVaultToolResult, VAULT_READ_TOOL_RESULT_LIMIT_BYTES } from "../harness/pi-native/vault-tool-result-safety";
import type { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import type { PersonalMemoryRuntimeContext } from "../harness/memory/personal-memory-contracts";
import type { PiKnowledgeReference } from "../harness/pi-native/contracts";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import type { ChatKnowledgeCandidate, ChatKnowledgeCandidatesResult } from "../knowledge-base/chat-knowledge-candidates";
import type { DecisionClient } from "../membership/decision-client";
import { redactEchoInkLocalSecretsV1 } from "../security/local-secrets";

export const ECHOINK_MCP_TOOL_NAMES = ["get_context", "get_user_profile", "search_memory", "read_memory", "explore_concept", "search_knowledge", "read_note"] as const;
export type EchoInkMcpToolName = typeof ECHOINK_MCP_TOOL_NAMES[number];
export interface McpReadAccess { knowledge: boolean; memory: boolean; pro: boolean; enabled: boolean }
export interface McpReadPorts {
  knowledge: ConceptExplorerPort & { search(input: KnowledgeAgentSearchRequest): Promise<KnowledgeAgentSearchResult>; scopeKey(): string; allowsPath(path: string): boolean };
  memory(): Promise<{ repository: PersonalMemoryRepository; vaultId: string }>;
  access(): McpReadAccess;
  /** Absent in hosts without the context pack; get_context is then not published. */
  context?: McpContextPorts;
}
/** 智能判断（PRO）的只读切面；null 或 ready() 为 false 时 get_context 走 self_serve。 */
export type McpDecisionPort = Pick<DecisionClient, "enabled" | "ready" | "exhausted" | "judgeMemory" | "judgeKnowledge" | "memoryDiagnostic">;
export interface McpContextPorts {
  /** Collect local, unjudged candidates without calling a model. */
  noteCandidates(task: string): Promise<Pick<ChatKnowledgeCandidatesResult, "candidates" | "stopReason">>;
  decisions(): McpDecisionPort | null;
}
const string = { type: "string", minLength: 1, maxLength: 1024 };
const page = { type: "integer", minimum: 1, maximum: 20 };
export const ECHOINK_MCP_TOOLS = [
  { name: "get_context", description: "Start here. Describe the current task in one or two sentences and get the user profile, related personal memories and related note passages in one call. Check data.mode: 'judged' means EchoInk already selected what is relevant; 'self_serve' means these are unjudged candidates and you must read the relevant ones yourself with read_memory / read_note.", properties: { task: { ...{ type: "string", minLength: 1 }, maxLength: 2000 }, recent: { ...{ type: "string", minLength: 1 }, maxLength: 1500 } }, required: ["task"] },
  { name: "get_user_profile", description: "Read the current user profile and bounded memory navigation (not an importance ranking).", properties: {}, required: [] },
  { name: "search_memory", description: "Search current personal memories for this task; an empty search is not proof of absence.", properties: { query: string, limit: page, cursor: string }, required: ["query"] },
  { name: "read_memory", description: "Read a current memory by ID, following nextOffset for longer records.", properties: { id: string, offset: { type: "integer", minimum: 0 } }, required: ["id"] },
  { name: "explore_concept", description: "Exact concept title or alias: bounded original excerpt, paged outgoing/back links, raw sources and optionally related memories. Resolve ambiguous candidates by vaultRelativePath. Links do not imply agreement.", properties: { name: { ...string, maxLength: 256 }, vaultRelativePath: string, cursor: string, candidateOffset: { type: "integer", minimum: 0 } }, required: ["name"] },
  { name: "search_knowledge", description: "Search the current Knowledge scope. Returns note paths, content revisions and bounded original excerpts; use read_note to read further.", properties: { query: string, limit: page, cursor: string }, required: ["query"] },
  { name: "read_note", description: "Read a note by path and expectedContentRevision, optionally by heading/block anchor or line/column range. Returns delivered range and continuation. On source_changed refresh the version.", properties: { vaultRelativePath: string, expectedContentRevision: string, anchor: string,
    lineStart: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 80 }, columnStart: { type: "integer", minimum: 0 }, columnEnd: { type: "integer", minimum: 0 } }, required: ["vaultRelativePath", "expectedContentRevision"] }
].map(tool => ({ name: tool.name as EchoInkMcpToolName, description: tool.description, inputSchema: { type: "object" as const, properties: tool.properties, required: tool.required, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));

export function mcpToolGrant(name: string): "knowledge" | "memory" | "any" | null {
  return name === "get_context" ? "any" : ["get_user_profile", "search_memory", "read_memory"].includes(name) ? "memory"
    : ["explore_concept", "search_knowledge", "read_note"].includes(name) ? "knowledge" : null;
}
export function assertMcpReadAccess(access: McpReadAccess, name: string): void {
  if (!access.enabled) throw Object.assign(new Error("Service disabled"), { code: "service_disabled" });
  if (!access.pro) throw Object.assign(new Error("Active PRO membership required"), { code: "membership_required" });
  const grant = mcpToolGrant(name);
  if (!grant || !(grant === "any" ? access.knowledge || access.memory : access[grant])) throw Object.assign(new Error("Read permission denied"), { code: "permission_denied" });
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
  /** Judged packs only: a repeat of the same task costs no judgment, no quota and no Vault scan. */
  private readonly packs = new Map<string, { expires: number; value: { data: Record<string, unknown>; sourceVersions: unknown[]; deliveredRanges: unknown[]; truncated: boolean } }>();
  constructor(private readonly ports: McpReadPorts) {}
  /** Call when a note in scope changes; memory changes are covered by the revision in the cache key. */
  invalidateContext(): void { this.packs.clear(); if (this.sweepTimer !== undefined) { window.clearTimeout(this.sweepTimer); this.sweepTimer = undefined; } }
  private sweepTimer: number | undefined;
  /** Nothing stays in memory past its expiry: one timer frees expired packs and stops itself when the cache is empty. */
  private scheduleSweep(): void {
    if (this.sweepTimer !== undefined) return;
    const timer = window.setTimeout(() => {
      this.sweepTimer = undefined;
      for (const [key, pack] of this.packs) if (pack.expires <= Date.now()) this.packs.delete(key);
      if (this.packs.size) this.scheduleSweep();
    }, CONTEXT_CACHE_MS + 1_000);
    // Under Node (tests) the timer must not keep the process alive.
    (timer as unknown as { unref?(): void }).unref?.();
    this.sweepTimer = timer;
  }
  list() { const access = this.ports.access(); return ECHOINK_MCP_TOOLS.filter(tool => { const grant = mcpToolGrant(tool.name); return access.enabled && access.pro && grant && (grant === "any" ? !!this.ports.context && (access.knowledge || access.memory) : access[grant]); }); }

  async call(name: string, raw: unknown, requestId: string, assertRequest: () => void = () => {}): Promise<McpToolEnvelope> {
    const base = { requestId, trust: "untrusted-background" as const, sourceVersions: [] as readonly unknown[], deliveredRanges: [] as readonly unknown[], truncated: false };
    try {
      assertRequest(); assertMcpReadAccess(this.ports.access(), name);
      const args = validateArguments(name, raw);
      const scope = this.ports.knowledge.scopeKey();
      const memoryAtStart = this.ports.access().memory, knowledgeAtStart = this.ports.access().knowledge;
      let data: Record<string, unknown>, references: readonly PiKnowledgeReference[] = [], sourceVersions: readonly unknown[] = [], deliveredRanges: readonly unknown[] = [], truncated = false;
      if (name === "get_context") {
        if (!this.ports.context) throw Object.assign(new Error("Context pack unavailable"), { code: "permission_denied" });
        ({ data, sourceVersions, deliveredRanges, truncated } = await this.context(args, requestId, assertRequest));
      } else if (name === "search_knowledge") {
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
          const collaboration = collaborationFromProfile(profile);
          data = { ...(collaboration ? { collaboration } : {}), profile: profile.slice(0, 4000), memoryNavigation: navigation.slice(0, 4000), navigationMeaning: "按日期和类别限制条数的有限记忆导航，不是最重要记忆摘要。" };
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
        const grant = mcpToolGrant(name);
        if ((grant === "knowledge" || grant === "any" && knowledgeAtStart) && scope !== this.ports.knowledge.scopeKey()) throw Object.assign(new Error("Knowledge scope changed"), { code: "permission_changed" });
        // One packed result mixes both grants: any grant change voids the whole result.
        if (grant === "any" && (this.ports.access().memory !== memoryAtStart || this.ports.access().knowledge !== knowledgeAtStart)) throw Object.assign(new Error("Grant changed"), { code: "permission_changed" });
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
  /** User-confirmed "how to work with me" lines for the handshake; null when memory is not shared or nothing is confirmed. */
  async collaborationNotes(): Promise<McpCollaboration | null> {
    const shared = () => { const access = this.ports.access(); return access.enabled && access.pro && access.memory; };
    if (!shared()) return null;
    const { repository } = await this.ports.memory();
    const { user } = await repository.loadFixedContext({ memoryMode: "normal" });
    return shared() ? collaborationFromProfile(user ?? "") : null;
  }

  /** One call: profile + related memories + related note passages. Falls back to unjudged candidates (self_serve). */
  private async context(args: Record<string, unknown>, requestId: string, assertRequest: () => void) {
    const ports = this.ports.context!, access = this.ports.access();
    const task = String(args.task).trim(), recent = typeof args.recent === "string" ? [args.recent] : undefined;
    // Grants, knowledge scope and memory revision are part of the key, so a cached pack never outlives what it was built from.
    let revision = -1;
    if (access.memory) { try { revision = (await (await this.ports.memory()).repository.loadFixedContext({ memoryMode: "normal" })).revision; } catch { /* the recall below reports the real error */ } }
    const key = JSON.stringify([task.replace(/\s+/gu, " "), recent ?? null, access.memory, access.knowledge, this.ports.knowledge.scopeKey(), revision]);
    const decisions = ports.decisions();
    const cached = this.packs.get(key);
    if (decisions?.enabled() && cached && cached.expires > Date.now()) {
      const value = structuredClone(cached.value);
      value.data.cached = true;
      return value;
    }
    this.packs.delete(key);
    // requestId doubles as the decision turnId: memory + knowledge judgments of one call are charged once.
    const judging = !!decisions?.ready(requestId);
    const data: Record<string, unknown> = {}, sourceVersions: unknown[] = [], deliveredRanges: unknown[] = [];
    let truncated = false, unjudged = false, noteSearchTimedOut = false, budget = CONTEXT_BUDGET_BYTES;
    const take = (value: unknown) => { const size = jsonBytes(value); if (size > budget) return false; budget -= size; return true; };
    if (access.memory) {
      const { repository, runtime } = await this.memoryRuntime(requestId);
      // External reads must not feed the in-app recall statistics.
      const harness = new PersonalMemoryRecallHarness({ prepareTurnSnapshot: (request, context) => repository.prepareTurnSnapshot(request, context), recordSecondaryRecallHits: async () => {} },
        judging ? { decisions: { diagnostic: turnId => decisions!.memoryDiagnostic(turnId), judgeMemory: request => decisions!.judgeMemory(request) } } : {});
      const prepared = await harness.prepareTurnContext({ memoryMode: "normal", query: task, recentConversation: recent, tokenBudget: judging ? 1200 : 2000,
        vaultId: runtime.vaultId, conversationId: runtime.conversationId, piSessionId: runtime.piSessionId, productRunId: runtime.productRunId, ...(judging ? { decisionTurnId: requestId } : {}) });
      assertRequest();
      const profile = (prepared.user ?? "").slice(0, 2000);
      data.profile = profile; budget -= jsonBytes(profile);
      const collaboration = collaborationFromProfile(prepared.user ?? "");
      if (collaboration) { data.collaboration = collaboration; budget -= jsonBytes(collaboration); }
      truncated ||= profile.length < (prepared.user ?? "").length;
      const judged = prepared.selectionReceipt?.route === "decisions";
      if (!judged && (prepared.selectionReceipt?.candidateCount ?? 0) > 0) unjudged = true;
      const memories: unknown[] = [];
      for (const candidate of prepared.recall?.candidates ?? []) {
        const { file: _file, score: _score, sourceSummary: _sourceSummary, basis: _basis, contentOrigin: _origin, ...item } = candidate;
        if (!take(item)) { truncated = true; break; }
        memories.push(item); deliveredRanges.push({ id: candidate.id, excerpt: true });
      }
      data.memories = { selection: judged ? "judged" : "unjudged", items: memories, total: prepared.recall?.total ?? 0, remaining: Math.max(0, (prepared.recall?.total ?? 0) - memories.length) };
      // Without a judgment the lexical match can miss; the navigation lets the agent browse by category.
      if (!judged && prepared.memory) { const navigation = prepared.memory.slice(0, 1500); if (take(navigation)) data.memoryNavigation = navigation; }
      sourceVersions.push({ source: "personal-memory", version: prepared.revision });
    }
    if (access.knowledge) {
      const allowed = (candidate: ChatKnowledgeCandidate) => this.ports.knowledge.allowsPath(candidate.hit.vaultRelativePath);
      const search = await ports.noteCandidates(task);
      const candidates = search.candidates.filter(allowed);
      noteSearchTimedOut = search.stopReason === "time_budget";
      assertRequest();
      const judgment = judging && !noteSearchTimedOut && candidates.length && decisions!.ready(requestId)
        ? await decisions!.judgeKnowledge({ turnId: requestId, text: task, recent, notes: candidates.map(candidate => candidate.note) }).catch(() => null) : null;
      assertRequest();
      if (!judgment && candidates.length) unjudged = true;
      const picked = (judgment ? candidates.filter(candidate => judgment.probabilities[candidate.note.id] >= judgment.threshold)
        .sort((left, right) => judgment.probabilities[right.note.id] - judgment.probabilities[left.note.id]).slice(0, 6) : candidates).filter(allowed);
      const notes: unknown[] = [];
      for (const { hit } of picked) {
        let note: Record<string, unknown> = { vaultRelativePath: hit.vaultRelativePath, title: hit.title, contentRevision: hit.contentRevision,
          ...(hit.sectionTitle ? { sectionTitle: hit.sectionTitle } : {}), lineStart: hit.lineStart, lineEnd: hit.lineEnd, excerpt: hit.excerpt ?? "" };
        if (judgment) {
          // Selected notes carry a readable passage; unjudged candidates stay as short excerpts for the agent to triage.
          try {
            const input = normalizePiKnowledgeReadToolArguments("knowledge_read", { vaultRelativePath: hit.vaultRelativePath, expectedContentRevision: hit.contentRevision, lineStart: hit.lineStart ?? 1, lineCount: 20 });
            const { reference, hasMore } = readToolResult(await this.ports.knowledge.read(input), input);
            const passage = { ...note, lineStart: reference.lineStart, lineEnd: reference.lineEnd, excerpt: reference.excerpt, hasMore };
            if (jsonBytes(passage) <= budget) note = passage;
          } catch { /* keep the search excerpt; read_note reports the precise error if the agent follows up */ }
          assertRequest();
        }
        if (!take(note)) { truncated = true; break; }
        notes.push(note);
        sourceVersions.push({ path: hit.vaultRelativePath, version: hit.contentRevision });
        deliveredRanges.push({ path: hit.vaultRelativePath, lineStart: note.lineStart, lineEnd: note.lineEnd });
      }
      data.notes = { selection: judgment ? "judged" : "unjudged", items: notes, total: picked.length, remaining: picked.length - notes.length };
    }
    const mode = judging && !unjudged && !noteSearchTimedOut ? "judged" : "self_serve";
    data.mode = mode;
    if (mode === "self_serve") {
      const resetAt = decisions?.exhausted() ?? null;
      data.reason = !decisions ? "unavailable" : !decisions.enabled() ? "smart_judgment_off" : resetAt ? "quota_exhausted"
        : noteSearchTimedOut ? "knowledge_search_timeout" : "temporarily_unavailable";
      if (resetAt) data.quotaResetAt = resetAt;
    }
    const guidance = mode === "judged"
      ? "EchoInk selected these for the task. Use read_memory / read_note only if you need more than what is delivered."
      : "EchoInk did not pre-select for this call. Items marked unjudged are candidates, not conclusions: read the ones that look relevant with read_memory / read_note and decide yourself before answering. Nothing pre-selected does not mean nothing relevant exists.";
    data.guidance = noteSearchTimedOut ? guidance + " The note search timed out. Use search_knowledge to continue looking for relevant notes." : guidance;
    truncated ||= noteSearchTimedOut;
    const value = { data, sourceVersions, deliveredRanges, truncated };
    // self_serve is cheap and must retry the judgment as soon as it is available again.
    if (mode === "judged") {
      this.packs.set(key, { expires: Date.now() + CONTEXT_CACHE_MS, value: structuredClone(value) });
      for (const oldest of this.packs.keys()) { if (this.packs.size <= CONTEXT_CACHE_ENTRIES) break; this.packs.delete(oldest); }
      this.scheduleSweep();
    }
    return value;
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
/** Leaves room for the envelope under VAULT_READ_TOOL_RESULT_LIMIT_BYTES. */
const CONTEXT_BUDGET_BYTES = 24_000;
const COLLABORATION_NOTES_LIMIT = 800;
/** Worst case 20 packs x 24 KB: about half a megabyte, released on expiry, on any note change and when the service stops. */
const CONTEXT_CACHE_MS = 10 * 60_000, CONTEXT_CACHE_ENTRIES = 20;
export interface McpCollaboration { version: string; marker: string; text: string; saving: string }
/**
 * The only profile content an external agent may keep: lines the user confirmed themselves.
 * System observations, memories and notes change faster and are more private, so they are never part of it.
 */
export function collaborationFromProfile(user: string): McpCollaboration | null {
  const lines = redactEchoInkLocalSecretsV1(user).split(/\r?\n/u).filter(line => line.startsWith("- ") && !line.includes("尚无已确认内容") && !line.endsWith("（系统观察，供参考）"));
  let text = "";
  for (const line of lines) { if (text.length + line.length + 1 > COLLABORATION_NOTES_LIMIT) break; text += `${line}\n`; }
  text = text.trim();
  if (!text) return null;
  // FNV-1a: a short, stable content version so a saved copy can be recognised as outdated.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  const version = (hash >>> 0).toString(16).padStart(8, "0");
  return { version, marker: `<!-- echoink-collaboration ${version} -->`, text, saving: COLLABORATION_SAVING };
}
export const COLLABORATION_SAVING = "You may offer to save `text` to your own global instructions file (AGENTS.md, CLAUDE.md, soul.md or similar). Ask the user first. If they agree, write `text` together with `marker`. When your file holds a marker with a different version, offer to replace that block. Save nothing else from EchoInk: no other profile lines, memories or notes.";
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? "").length;
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
