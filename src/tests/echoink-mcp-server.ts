import { type App, TFile } from "obsidian";
import { createConceptExplorerPort } from "../knowledge-base/obsidian-concept-explorer";
import { VaultBodySearch } from "../knowledge-base/vault-body-search";
import type { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { EchoInkMcpServer } from "../mcp-server/server";
import { EchoInkMcpReadTools, collaborationFromProfile, type McpDecisionPort, type McpReadPorts } from "../mcp-server/tools";
import { normalizeEchoInkMcpServerSettings } from "../mcp-server/settings";
import { exploreConcept } from "../knowledge-base/concept-explorer";
import { PiConceptToolSecurity, createPiConceptTool } from "../harness/pi-native/pi-concept-tool";
import { piWorkspaceToolDecision } from "../harness/pi-native/pi-workspace-access";
import { knowledgeReadingState } from "../harness/pi-native/knowledge-ask-protocol";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import type { KnowledgeAgentReadResult } from "../knowledge-base/knowledge-agent-index";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export async function runEchoInkMcpServerTests() {
  const access = { enabled: true, knowledge: true, memory: true, pro: true };
  let scope = "scope-1", memoryCalls = 0, token = "a".repeat(64);
  const syntheticCredential = randomUUID().replaceAll("-", "");
  let waitForRead: (() => Promise<void>) | undefined;
  const snapshot: KnowledgeAgentReadResult = { entryId: "fixture", vaultRelativePath: "Notes/概念.md", title: "概念", kind: "notes", contentRevision: `sha256:${"a".repeat(64)}`, recordedAt: 1, verificationStatus: "local_revision_verified", rawSources: [], content: `# 概念\n只读原文\nAuthorization: Bearer ${syntheticCredential}\n` };
  const related = { vaultRelativePath: snapshot.vaultRelativePath, contentRevision: snapshot.contentRevision, total: 0, returned: 0, remaining: 0, hasMore: false, exhausted: true, items: [] };
  let recallStatsWrites = 0;
  const memoryCatalog = [
    { id: "memory-1", kind: "preference", title: "MEMORY_PRIVATE 协作偏好", recallWhen: "协作", summary: "先给结论", date: "2026-11-01", score: 0, status: "current", basis: "user_stated", sourceSummary: "SOURCE_SUMMARY_INTERNAL", file: "FILE_INTERNAL" },
    { id: "memory-2", kind: "decision", title: "MEMORY_PRIVATE 无关决定", recallWhen: "无关", summary: "无关", date: "2026-11-02", score: 3, status: "current", basis: "user_stated", sourceSummary: "SOURCE_SUMMARY_INTERNAL", file: "FILE_INTERNAL" }
  ];
  const repository = {
    loadFixedContext: async () => { memoryCalls++; await waitForRead?.(); return { user: `# USER\n\n本文件是系统生成的画像。\n\n## 用户明确确认\n\n- 【沟通】MEMORY_PRIVATE_PROFILE 先给结论\n- 【密钥】Authorization: Bearer ${syntheticCredential}\n\n## 系统观察\n\n- 【习惯】OBSERVED_ONLY（系统观察，供参考）\n`, memory: "有限导航", revision: 1 }; },
    prepareTurnSnapshot: async (request: { includeUnmatchedCandidates?: boolean; preferredCandidateIds?: readonly string[]; selectCandidateIds?(candidates: readonly unknown[]): unknown }) => {
      memoryCalls++;
      if (request.includeUnmatchedCandidates) request.selectCandidateIds?.(memoryCatalog);
      const items = request.preferredCandidateIds ? memoryCatalog.filter(memory => request.preferredCandidateIds!.includes(memory.id)) : memoryCatalog.filter(memory => memory.score > 0);
      return { revision: 1, agent: "", user: "# USER\n\n- 【沟通】MEMORY_PRIVATE_PROFILE 先给结论\n", memory: "有限导航", injectionKeys: [], core: [], scanned: items.length,
        search: { items, total: items.length, remaining: 0, exhausted: true, directory: [] } };
    },
    recordSecondaryRecallHits: async () => { recallStatsWrites++; },
    search: async () => { memoryCalls++; await waitForRead?.(); return { revision: 1, items: [{ id: "memory-1", title: "MEMORY_PRIVATE", content: "MEMORY_PRIVATE" }] }; },
    read: async () => { memoryCalls++; return { revision: 1, record: { id: "memory-1", revision: 1, content: "m".repeat(7000) } }; }
  } as unknown as PersonalMemoryRepository;
  const judgment = { enabled: true, ready: true, exhausted: null as string | null, answer: true, memoryTurns: [] as string[], knowledgeTurns: [] as string[] };
  const decisions: McpDecisionPort = { enabled: () => judgment.enabled, ready: () => judgment.enabled && judgment.ready && !judgment.exhausted, exhausted: () => judgment.exhausted, memoryDiagnostic: () => undefined,
    judgeMemory: async input => { judgment.memoryTurns.push(input.turnId); return judgment.answer ? { selected: ["memory-1"], probabilities: { "memory-1": 0.95, "memory-2": 0.1 }, threshold: 0.9 } : null; },
    judgeKnowledge: async input => { judgment.knowledgeTurns.push(input.turnId); return judgment.answer ? { probabilities: Object.fromEntries(input.notes.map(note => [note.id, note.id === "n0" ? 0.9 : 0.1])), threshold: 0.65 } : null; } };
  let decisionPort: McpDecisionPort | null = decisions;
  let noteSearchTimedOut = false;
  const ports: McpReadPorts = { access: () => access, memory: async () => ({ repository, vaultId: "test-vault" }),
    knowledge: { scopeKey: () => scope, allowsPath: value => !value.startsWith("private/"), candidates: async name => name === "概念" || name === "别名" ? [snapshot.vaultRelativePath] : name === "同名" ? [snapshot.vaultRelativePath, "Notes/other.md"] : [],
      read: async input => { await waitForRead?.(); if (input.vaultRelativePath.startsWith("private/")) throw Object.assign(new Error(), { code: "invalid_path" });
        if (input.expectedContentRevision && input.expectedContentRevision !== snapshot.contentRevision) throw Object.assign(new Error(), { code: "source_changed" }); return { ...snapshot, vaultRelativePath: input.vaultRelativePath }; },
      related: async () => related,
      search: async () => ({ generation: 1, total: 1, returned: 1, remaining: 0, hasMore: false, exhausted: true, hits: [{ ...snapshot, content: undefined, excerpt: "只读原文", lineStart: 2, lineEnd: 2, totalLines: 4 }] })
    },
    context: { decisions: () => decisionPort,
      noteCandidates: async () => noteSearchTimedOut ? { candidates: [], stopReason: "time_budget" } : {
        stopReason: "exhausted",
        candidates: [snapshot.vaultRelativePath, "Notes/other.md", "private/secret.md"].map((vaultRelativePath, index) => ({
          note: { id: `n${index}`, title: "概念", excerpt: "只读原文" },
          hit: { ...snapshot, vaultRelativePath, content: undefined, excerpt: "只读原文", lineStart: 2, lineEnd: 2, totalLines: 4 } as never
        }))
      } } };
  const tools = new EchoInkMcpReadTools(ports);
  assert.deepEqual(normalizeEchoInkMcpServerSettings(null), { enabled: false, knowledge: true, memory: true, token: "", tokenVault: "", port: 0 });
  assert.equal(normalizeEchoInkMcpServerSettings({ knowledge: false }).knowledge, false);
  assert.equal(normalizeEchoInkMcpServerSettings({ knowledge: false }).memory, true);
  assert.equal(normalizeEchoInkMcpServerSettings({ memory: false }).knowledge, true);
  assert.equal(normalizeEchoInkMcpServerSettings({ memory: false }).memory, false);
  assert.deepEqual(normalizeEchoInkMcpServerSettings({ knowledge: true, memory: true }), normalizeEchoInkMcpServerSettings({}));
  assert.equal(tools.list().length, 7); assert.equal(tools.list()[0].name, "get_context");
  assert.ok(!new EchoInkMcpReadTools({ ...ports, context: undefined }).list().some(tool => tool.name === "get_context"), "hosts without the context pack do not publish it");
  // get_context: judged pack, one decision turn for both judgments, no in-app recall statistics.
  type Pack = { mode: string; reason?: string; quotaResetAt?: string; profile?: string; memoryNavigation?: string; memories?: { selection: string; items: Array<{ id: string }> }; notes?: { selection: string; items: Array<{ vaultRelativePath: string; excerpt: string }> } };
  const pack = async (id: string, args: object = { task: "怎么和我协作" }) => { const envelope = await tools.call("get_context", args, id); return { envelope, data: envelope.data as unknown as Pack }; };
  const judged = await pack("turn-judged");
  assert.equal(judged.envelope.ok, true, JSON.stringify(judged.envelope)); assert.equal(judged.data.mode, "judged"); assert.equal(judged.data.reason, undefined);
  assert.ok(judged.data.profile?.includes("先给结论")); assert.equal(judged.data.memoryNavigation, undefined);
  assert.deepEqual(judged.data.memories?.items.map(item => item.id), ["memory-1"], "the judgment, not the lexical score, picks memories"); assert.equal(judged.data.memories?.selection, "judged");
  assert.deepEqual(judged.data.notes?.items.map(item => item.vaultRelativePath), [snapshot.vaultRelativePath]); assert.ok(judged.data.notes?.items[0].excerpt.includes("只读原文"));
  assert.deepEqual([judgment.memoryTurns, judgment.knowledgeTurns], [["turn-judged"], ["turn-judged"]], "both judgments share the request's turn id, so one call is charged once");
  for (const leaked of [syntheticCredential, "SOURCE_SUMMARY_INTERNAL", "FILE_INTERNAL", "private/secret.md"]) assert.ok(!JSON.stringify(judged.envelope).includes(leaked), leaked);
  assert.ok(judged.envelope.sourceVersions.length >= 2); assert.equal(recallStatsWrites, 0);
  // Same task again: served from the pack cache, no second judgment (no quota), until a note changes.
  const repeated = await pack("turn-repeat", { task: "怎么和我协作  " });
  assert.equal((repeated.data as { cached?: boolean }).cached, true); assert.equal(repeated.envelope.requestId, "turn-repeat"); assert.deepEqual(repeated.data.memories, judged.data.memories);
  assert.deepEqual([judgment.memoryTurns.length, judgment.knowledgeTurns.length], [1, 1], "a repeated task is not judged or charged again");
  judgment.exhausted = "2026-12-01T00:00:00+08:00"; assert.equal((await pack("turn-cached-exhausted")).data.mode, "judged", "a cached pack still serves after the quota runs out"); judgment.exhausted = null;
  judgment.enabled = false;
  const disabledWithCache = await pack("turn-cached-disabled");
  assert.equal(disabledWithCache.data.mode, "self_serve", "turning judgment off takes effect even for the same cached task");
  assert.equal(disabledWithCache.data.notes?.selection, "unjudged");
  assert.deepEqual([judgment.memoryTurns.length, judgment.knowledgeTurns.length], [1, 1]);
  judgment.enabled = true;
  tools.invalidateContext(); assert.equal((await pack("turn-after-change")).data.mode, "judged");
  assert.deepEqual([judgment.memoryTurns.length, judgment.knowledgeTurns.length], [2, 2], "a Vault change drops the cache");
  const cache = tools as unknown as { packs: Map<string, { expires: number }>; sweepTimer?: unknown };
  assert.equal(cache.packs.size, 1); assert.notEqual(cache.sweepTimer, undefined, "cached packs are released by a timer, not held until the next call");
  for (let index = 0; index < 25; index++) await pack(`turn-fill-${index}`, { task: `不同任务 ${index}` });
  assert.ok(cache.packs.size <= 20, "the cache is bounded");
  judgment.memoryTurns.length = 1; judgment.knowledgeTurns.length = 1; tools.invalidateContext();
  assert.equal(cache.packs.size, 0); assert.equal(cache.sweepTimer, undefined, "invalidation frees the packs and the timer");
  // Quota used up: no judgment request, unjudged candidates for the agent to read with its own tokens.
  judgment.exhausted = "2026-12-01T00:00:00+08:00";
  const exhausted = await pack("turn-exhausted");
  assert.equal(exhausted.envelope.ok, true); assert.equal(exhausted.data.mode, "self_serve"); assert.equal(exhausted.data.reason, "quota_exhausted"); assert.equal(exhausted.data.quotaResetAt, judgment.exhausted);
  assert.deepEqual([judgment.memoryTurns.length, judgment.knowledgeTurns.length], [1, 1], "an exhausted quota sends no judgment request");
  assert.equal(exhausted.data.memories?.selection, "unjudged"); assert.deepEqual(exhausted.data.memories?.items.map(item => item.id), ["memory-2"]); assert.equal(exhausted.data.memoryNavigation, "有限导航");
  assert.equal(exhausted.data.notes?.selection, "unjudged"); assert.deepEqual(exhausted.data.notes?.items.map(item => item.vaultRelativePath), [snapshot.vaultRelativePath, "Notes/other.md"]);
  judgment.exhausted = null; judgment.enabled = false; assert.equal((await pack("turn-off")).data.reason, "smart_judgment_off"); judgment.enabled = true;
  decisionPort = null; assert.equal((await pack("turn-none")).data.reason, "unavailable"); decisionPort = decisions;
  tools.invalidateContext(); judgment.answer = false; const failed = await pack("turn-failed"); assert.equal(failed.data.mode, "self_serve"); assert.equal(failed.data.reason, "temporarily_unavailable"); judgment.answer = true;
  noteSearchTimedOut = true;
  const timedOut = await pack("turn-note-timeout");
  assert.equal(timedOut.data.mode, "self_serve");
  assert.equal(timedOut.data.reason, "knowledge_search_timeout");
  assert.equal(timedOut.envelope.truncated, true);
  noteSearchTimedOut = false;
  const recovered = await pack("turn-note-ready");
  assert.equal(recovered.data.mode, "judged");
  assert.deepEqual(recovered.data.notes?.items.map(item => item.vaultRelativePath), [snapshot.vaultRelativePath]);
  assert.equal((await tools.call("get_context", {}, "no-task")).error?.code, "invalid_arguments");
  tools.invalidateContext(); access.knowledge = false; const memoryOnly = await pack("turn-memory-only"); assert.equal(memoryOnly.data.mode, "judged"); assert.equal(memoryOnly.data.notes, undefined); access.knowledge = true;
  access.memory = false; const beforePack = memoryCalls; const knowledgeOnly = await pack("turn-knowledge-only");
  assert.equal(knowledgeOnly.data.mode, "judged"); assert.equal(knowledgeOnly.data.profile, undefined); assert.equal(knowledgeOnly.data.memories, undefined);
  assert.ok(!JSON.stringify(knowledgeOnly.envelope).includes("MEMORY_PRIVATE")); assert.equal(memoryCalls, beforePack); access.memory = true;
  // Saveable collaboration block: user-confirmed lines only, versioned by content.
  const notes = (await tools.collaborationNotes())!;
  assert.ok(notes.text.includes("【沟通】")); for (const excluded of [syntheticCredential, "系统生成", "OBSERVED_ONLY"]) assert.ok(!notes.text.includes(excluded), excluded);
  assert.match(notes.version, /^[0-9a-f]{8}$/u); assert.equal(notes.marker, `<!-- echoink-collaboration ${notes.version} -->`);
  assert.equal(collaborationFromProfile("- 【沟通】先给结论")?.version, collaborationFromProfile("# USER\n\n- 【沟通】先给结论\n- 【习惯】x（系统观察，供参考）")?.version, "observations do not change the version");
  assert.notEqual(collaborationFromProfile("- 【沟通】先给结论")?.version, collaborationFromProfile("- 【沟通】先给细节")?.version);
  assert.equal(collaborationFromProfile("# USER\n\n- 尚无已确认内容。\n- 【习惯】x（系统观察，供参考）"), null);
  assert.equal(((await tools.call("get_user_profile", {}, "profile-collab")).data as { collaboration?: { version: string } }).collaboration?.version, notes.version);
  assert.ok((judged.data as { collaboration?: { saving: string } }).collaboration?.saving.includes("Ask the user first"));
  const profile = await tools.call("get_user_profile", {}, "request-profile");
  assert.equal(profile.ok, true); assert.equal(profile.requestId, "request-profile");
  const note = await tools.call("read_note", { vaultRelativePath: snapshot.vaultRelativePath, expectedContentRevision: snapshot.contentRevision }, "request-note");
  assert.equal(note.ok, true); assert.ok(!JSON.stringify(note).includes(syntheticCredential)); assert.ok(note.deliveredRanges.length);
  assert.equal((await tools.call("read_note", { vaultRelativePath: snapshot.vaultRelativePath, expectedContentRevision: `sha256:${"b".repeat(64)}` }, "stale")).error?.code, "source_changed");
  assert.equal((await tools.call("read_note", { vaultRelativePath: "private/secret.md", expectedContentRevision: snapshot.contentRevision }, "private")).error?.code, "invalid_path");
  assert.equal((await tools.call("search_knowledge", { query: "abc", vaultPath: "/tmp" }, "bad")).error?.code, "invalid_arguments");
  assert.equal((await tools.call("write_note", {}, "write")).error?.code, "permission_denied");
  assert.equal((await tools.call("read_memory", { id: "memory-1" }, "memory-page")).data?.nextOffset, 6000);
  assert.equal((await exploreConcept(ports.knowledge, { name: "同名" })).data.status, "ambiguous");
  assert.equal((await exploreConcept(ports.knowledge, { name: "missing" })).data.status, "unresolved");
  assert.equal((await exploreConcept(ports.knowledge, { name: "别名" })).references.length, 1);
  access.memory = false; const beforeMemory = memoryCalls;
  assert.deepEqual(tools.list().map(tool => tool.name), ["get_context", "explore_concept", "search_knowledge", "read_note"]); assert.equal(await tools.collaborationNotes(), null);
  for (const name of ["get_user_profile", "search_memory", "read_memory"]) assert.equal((await tools.call(name, { query: "x", id: "x" }, "denied")).error?.code, "permission_denied");
  const concept = await tools.call("explore_concept", { name: "概念" }, "concept-no-memory");
  assert.equal(concept.ok, true); assert.ok(!JSON.stringify(concept).includes("MEMORY_PRIVATE")); assert.equal(memoryCalls, beforeMemory);
  access.memory = true;
  let release!: () => void, started!: () => void;
  let began = new Promise<void>(resolve => { started = resolve; });
  waitForRead = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
  const pending = tools.call("get_user_profile", {}, "revoked"); await began; access.memory = false; release();
  assert.equal((await pending).error?.code, "permission_denied");
  began = new Promise<void>(resolve => { started = resolve; });
  const pendingScope = tools.call("read_note", { vaultRelativePath: snapshot.vaultRelativePath, expectedContentRevision: snapshot.contentRevision }, "scope");
  await began; scope = "scope-2"; release(); assert.equal((await pendingScope).error?.code, "permission_changed"); waitForRead = undefined;
  access.pro = false; assert.deepEqual(tools.list(), []); assert.equal((await tools.call("search_knowledge", { query: "x" }, "expired")).error?.code, "membership_required"); access.pro = true;
  const server = new EchoInkMcpServer({ tools, access: () => access, token: () => token, version: "test" });
  assert.equal(server.setupText(), null);
  access.pro = false; await server.start(); assert.equal(server.read().status, "stopped"); access.pro = true;
  const occupied = http.createServer(); await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  const occupiedPort = (occupied.address() as { port: number }).port;
  await server.start(occupiedPort); const port = server.read().port!; assert.notEqual(port, occupiedPort); assert.equal(server.read().status, "running");
  assert.ok(server.setupText()?.includes(`127.0.0.1:${port}`)); assert.ok(server.setupText()?.includes("https://echoink.cn/skills/echoink/SKILL.md"));
  const rpc = async (method: string, params: object = {}, options: { token?: string; host?: string; origin?: string } = {}) => await new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/mcp", method: "POST", agent: false, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${options.token ?? token}`, ...(options.host ? { Host: options.host } : {}), ...(options.origin ? { Origin: options.origin } : {}) } }, res => { let body = "";res.on("data", chunk => body += String(chunk));res.on("end", () => resolve({ status: res.statusCode!, value: body ? JSON.parse(body) as Record<string, unknown> : {} })); });
    req.on("error", reject);req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
  try {
    const initialize = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(initialize.status, 200, JSON.stringify(initialize)); assert.ok(JSON.stringify(initialize.value).includes("get_context"));
    // Memory is revoked at this point: the handshake must not carry profile lines until it is shared again.
    assert.ok(!JSON.stringify(initialize.value).includes("MEMORY_PRIVATE"), "no notes without the memory grant");
    access.memory = true; const shared = JSON.stringify((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).value); access.memory = false;
    assert.ok(shared.includes("【沟通】"), "the handshake carries the collaboration notes"); assert.ok(!shared.includes(syntheticCredential));
    assert.ok(shared.includes("echoink-collaboration") && shared.includes("Ask the user first") && !shared.includes("OBSERVED_ONLY"));
    assert.equal((await rpc("tools/list", {}, { token: "wrong" })).status, 401);
    assert.equal((await rpc("tools/list", {}, { host: `evil.example:${port}` })).status, 403);
    assert.equal((await rpc("tools/list", {}, { origin: "https://evil.example" })).status, 403);
    const discovery = await rpc("tools/list"); assert.equal(discovery.status, 200); assert.ok(!JSON.stringify(discovery.value).includes('"name":"search_memory"'));
    const toolArguments = {
      get_context: { task: "概念" }, get_user_profile: {}, search_memory: { query: "概念" }, read_memory: { id: "memory-1" },
      explore_concept: { name: "概念" }, search_knowledge: { query: "概念" },
      read_note: { vaultRelativePath: snapshot.vaultRelativePath, expectedContentRevision: snapshot.contentRevision }
    };
    const assertHttpGrants = async (knowledge: boolean, memory: boolean) => {
      Object.assign(access, { knowledge, memory }); server.revoke();
      const listed = await rpc("tools/list"); assert.equal(listed.status, 200);
      const names = (listed.value.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);
      const expected = [...knowledge || memory ? ["get_context"] : [], ...memory ? ["get_user_profile", "search_memory", "read_memory"] : [], ...knowledge ? ["explore_concept", "search_knowledge", "read_note"] : []];
      assert.deepEqual(names, expected, "HTTP discovery follows both saved grant switches");
      for (const [name, args] of Object.entries(toolArguments)) {
        const called = await rpc("tools/call", { name, arguments: args }); assert.equal(called.status, 200);
        const result = called.value.result as { isError: boolean; content: Array<{ text: string }> };
        const envelope = JSON.parse(result.content[0].text) as { ok: boolean; error?: { code: string } };
        assert.equal(envelope.ok, expected.includes(name), `${name} call follows its grant`);
        assert.equal(result.isError, !expected.includes(name));
        if (!expected.includes(name)) assert.equal(envelope.error?.code, "permission_denied");
      }
    };
    await assertHttpGrants(true, true);
    await assertHttpGrants(false, true);
    await assertHttpGrants(false, false);
    await assertHttpGrants(true, false);
    await assertHttpGrants(true, true);
    const old = token; token = "b".repeat(64); server.revoke(); assert.equal((await rpc("tools/list", {}, { token: old })).status, 401); assert.equal((await rpc("tools/list")).status, 200);
    access.pro = false; assert.equal((await rpc("tools/list")).status, 403); access.pro = true;
    const second = new EchoInkMcpServer({ tools, access: () => access, token: () => "c".repeat(64), version: "test" });
    try { await second.start(port); assert.notEqual(second.read().port, port); assert.ok(second.setupText()?.includes("c".repeat(64))); } finally { await second.stop(); }
    await server.stop(); assert.equal(server.setupText(), null);
    const released = http.createServer(); await new Promise<void>(resolve => released.listen(port, "127.0.0.1", resolve)); await new Promise<void>(resolve => released.close(() => resolve()));
    await server.start(port); assert.equal(server.read().port, port);
  } finally { await server.stop(); await new Promise<void>(resolve => occupied.close(() => resolve())); }
  // In-app concept publication, read-only/Plan access and delivered reading records.
  const identity = { vaultId: "v", conversationId: "c", piSessionId: "s", productRunId: "r", userEntryId: "e" };
  let internalMemory = false, internalSearches = 0;
  const security = new PiConceptToolSecurity({ port: ports.knowledge, identity: () => identity, assertAllowed: async () => {}, scopeKey: () => scope, canMemory: () => internalMemory,
    searchMemory: async () => { internalSearches++; return "MEMORY_PRIVATE"; } });
  const tool = createPiConceptTool(security);
  assert.equal(piWorkspaceToolDecision({ permission: "read-only", mode: "agent", memoryMode: "no_memory", toolName: tool.name, planToolNames: [], memoryToolNames: [], externalReadToolNames: [] }).allowed, true);
  assert.equal(piWorkspaceToolDecision({ permission: "read-only", mode: "plan", memoryMode: "no_memory", toolName: tool.name, planToolNames: [tool.name], memoryToolNames: [], externalReadToolNames: [] }).allowed, true);
  const callEvent = { toolName: tool.name, toolCallId: "internal-1", input: { name: "概念" } } as never;
  assert.equal(await security.handleToolCall(callEvent), undefined); await security.execute("internal-1", { name: "概念" });
  const delivered = await security.handleToolResult({ toolName: tool.name, toolCallId: "internal-1", isError: false } as never);
  assert.equal(delivered.isError, false); assert.equal(internalSearches, 0); assert.ok(!JSON.stringify(delivered.content).includes("MEMORY_PRIVATE"));
  const state = knowledgeReadingState([], [{ role: "toolResult", toolName: tool.name, toolCallId: "internal-1", content: delivered.content, details: delivered.details, isError: false, timestamp: 1 } as unknown as AgentMessage]);
  assert.ok(state.includes(snapshot.vaultRelativePath)); assert.ok(state.includes("deliveredRanges"));
  internalMemory = true;
  await security.handleToolCall({ ...callEvent as object, toolCallId: "internal-2" } as never); await security.execute("internal-2", { name: "概念" }); internalMemory = false;
  assert.ok(!JSON.stringify((await security.handleToolResult({ toolName: tool.name, toolCallId: "internal-2", isError: false } as never)).content).includes("MEMORY_PRIVATE"));
  const bodies = new Map([["A.md", "# A\n[[B]]"], ["B.md", "# B\n[[A]]"]]);
  const files = [...bodies].map(([name, text]) => Object.assign(new TFile(name), { path: name, basename: name.slice(0, -3), extension: "md", stat: { mtime: 1, ctime: 1, size: text.length } }));
  const app = { vault: { getMarkdownFiles: () => files, getAbstractFileByPath: (name: string) => files.find(file => file.path === name), read: async (file: TFile) => bodies.get(file.path)! },
    metadataCache: { resolvedLinks: { "A.md": { "B.md": 1 }, "B.md": { "A.md": 1 } }, getFileCache: () => null, getFirstLinkpathDest: (name: string) => files.find(file => file.basename === name) } } as unknown as App;
  const body = new VaultBodySearch(app, () => null);
  try {
    const conceptPort = createConceptExplorerPort(app, {} as KnowledgeAgentIndex, body);
    const links = await conceptPort.related({ vaultRelativePath: "A.md", limit: 1 });
    assert.equal(links.total, 2); assert.equal(links.returned, 1); assert.equal(links.hasMore, true);
    const next = await conceptPort.related({ vaultRelativePath: "A.md", limit: 1, cursor: links.continuationCursor });
    assert.equal(next.items[0].direction, "incoming"); assert.equal(next.items[0].source.vaultRelativePath, "B.md");
    const alias = await conceptPort.candidates("A"); assert.deepEqual(alias, ["A.md"]);
  } finally { body.dispose(); }
  console.log("EchoInk MCP: seven tools; get_context judged/self_serve (quota, off, unavailable, failed) with single-turn charging and no recall statistics; handshake collaboration notes; missing/explicit-false grants; HTTP grant toggle discovery/calls; non-PRO start denial; auth discovery/call/egress; memory-off isolation; in-flight revocation; scope/version boundaries; redaction; HTTP token/Host/Origin; port collision/reload/two Vault instances; membership expiry; in-app concept/Plan/reading records: PASS");
}
