import { type App, TFile } from "obsidian";
import { createConceptExplorerPort } from "../knowledge-base/obsidian-concept-explorer";
import { VaultBodySearch } from "../knowledge-base/vault-body-search";
import type { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { EchoInkMcpServer } from "../mcp-server/server";
import { EchoInkMcpReadTools, type McpReadPorts } from "../mcp-server/tools";
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
  const repository = {
    loadFixedContext: async () => { memoryCalls++; await waitForRead?.(); return { user: "MEMORY_PRIVATE_PROFILE", memory: "有限导航", revision: 1 }; },
    search: async () => { memoryCalls++; await waitForRead?.(); return { revision: 1, items: [{ id: "memory-1", title: "MEMORY_PRIVATE", content: "MEMORY_PRIVATE" }] }; },
    read: async () => { memoryCalls++; return { revision: 1, record: { id: "memory-1", revision: 1, content: "m".repeat(7000) } }; }
  } as unknown as PersonalMemoryRepository;
  const ports: McpReadPorts = { access: () => access, memory: async () => ({ repository, vaultId: "test-vault" }),
    knowledge: { scopeKey: () => scope, allowsPath: value => !value.startsWith("private/"), candidates: async name => name === "概念" || name === "别名" ? [snapshot.vaultRelativePath] : name === "同名" ? [snapshot.vaultRelativePath, "Notes/other.md"] : [],
      read: async input => { await waitForRead?.(); if (input.vaultRelativePath.startsWith("private/")) throw Object.assign(new Error(), { code: "invalid_path" });
        if (input.expectedContentRevision && input.expectedContentRevision !== snapshot.contentRevision) throw Object.assign(new Error(), { code: "source_changed" }); return { ...snapshot, vaultRelativePath: input.vaultRelativePath }; },
      related: async () => related,
      search: async () => ({ generation: 1, total: 1, returned: 1, remaining: 0, hasMore: false, exhausted: true, hits: [{ ...snapshot, content: undefined, excerpt: "只读原文", lineStart: 2, lineEnd: 2, totalLines: 4 }] })
    } };
  const tools = new EchoInkMcpReadTools(ports);
  assert.deepEqual(normalizeEchoInkMcpServerSettings(null), { enabled: false, knowledge: false, memory: false, token: "", tokenVault: "", port: 0 });
  assert.equal(tools.list().length, 6);
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
  assert.deepEqual(tools.list().map(tool => tool.name), ["explore_concept", "search_knowledge", "read_note"]);
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
    assert.equal(initialize.status, 200, JSON.stringify(initialize)); assert.ok(JSON.stringify(initialize.value).includes("get_user_profile"));
    assert.equal((await rpc("tools/list", {}, { token: "wrong" })).status, 401);
    assert.equal((await rpc("tools/list", {}, { host: `evil.example:${port}` })).status, 403);
    assert.equal((await rpc("tools/list", {}, { origin: "https://evil.example" })).status, 403);
    const discovery = await rpc("tools/list"); assert.equal(discovery.status, 200); assert.ok(!JSON.stringify(discovery.value).includes('"name":"search_memory"'));
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
  console.log("EchoInk MCP: six tools; auth discovery/call/egress; memory-off isolation; in-flight revocation; scope/version boundaries; redaction; HTTP token/Host/Origin; port collision/reload/two Vault instances; membership expiry; in-app concept/Plan/reading records: PASS");
}
