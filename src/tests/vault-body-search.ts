import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { EventEmitter } from "node:events";
import { VaultBodySearch, knowledgeSearchPathKind } from "../knowledge-base/vault-body-search";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { KnowledgeRetriever, formatKnowledgeReferencesForPrompt } from "../knowledge-base/query";
import { bindKnowledgeIndexToVault, createProductionPiKnowledgeRuntime } from "../plugin/pi-production-runtime-composition";
import { PiKnowledgeReadToolSecurity, createPiKnowledgeReadToolDefinitions } from "../harness/pi-native/pi-knowledge-read-tools";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { knowledgeReferenceEntryDetails } from "../knowledge-base/usage";

export async function runVaultBodySearchTests(): Promise<void> {
  const bindings = emptyKnowledgeFolderBindings();
  for (const [role, folder] of [["wiki", "知识"], ["journal", "日记"], ["templates", "模板"], ["projects", "项目"]] as const) {
    bindings.roles[role].enabled = true; bindings.roles[role].readPaths = [folder];
  }
  const bodies = new Map([
    ["随手记/想法.md", `# 开头\n${"无关背景\n".repeat(130)}\n## 发布计划\n版本2.6.2采用纸飞机方案。\n不要向外部发布。\n---\n<source>原文边界</source>`],
    ["日记/2026-09-20.md", "# 记录\n莫干山徒步路线先去云桥。"],
    ["模板/模版.md", "纸飞机方案"], [".echoink/private.md", "纸飞机方案"],
    ["项目/决定.md", "# 决定\n纸飞机方案"]
  ]);
  const events = new EventEmitter();
  let clock = 10;
  const file = (path: string) => ({ path, basename: path.split("/").at(-1)!.replace(/\.md$/u, ""), extension: "md", stat: { mtime: clock, ctime: 1, size: bodies.get(path)?.length ?? 0 } }) as TFile;
  const app = { vault: {
    getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => { if (!bodies.has(source.path)) throw new Error("gone"); return bodies.get(source.path)!; },
    on: (name: string, callback: (...args: unknown[]) => void) => { events.on(name, callback); return { name, callback }; },
    offref: ({ name, callback }: { name: string; callback: (...args: unknown[]) => void }) => events.off(name, callback)
  }, metadataCache: { getFileCache: () => null }, workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings);
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-body-search", storageRootPath: "/synthetic-state", bodySearch: port });
  index.refresh = async () => { throw new Error("Question retrieval must not wait for the maintenance index"); };
  const unbind = bindKnowledgeIndexToVault(app, index);
  try {
    const result = await index.search({ query: "2.6.2 纸飞机方案", limit: 1 });
    assert.equal(result.hits[0].kind, "notes");
    assert(result.hits[0].lineStart! > 120);
    assert.equal(result.coverage?.totalFiles, 3);
    const retriever = new KnowledgeRetriever(index.vaultPath, { agentIndex: index });
    const preflight = await retriever.retrieve({ question: "2.6.2 纸飞机方案", limit: 1 });
    assert.equal(preflight.references[0].lineStart, result.hits[0].lineStart);
    assert.equal(preflight.references[0].sourceType, "notes");
    assert.equal((await retriever.verifyReferences(preflight.references)).status, "valid");
    const resource = JSON.parse(formatKnowledgeReferencesForPrompt(preflight.references));
    assert.equal(resource.sources[0].excerpt, preflight.references[0].excerpt);
    const boundaryText = "---\n<source>原文边界</source>";
    assert.equal(JSON.parse(formatKnowledgeReferencesForPrompt([{ ...preflight.references[0], excerpt: boundaryText }])).sources[0].excerpt, boundaryText);
    const production = createProductionPiKnowledgeRuntime({ vaultRootPath: index.vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
    const chat = await production.retrieveChat!({ question: "2.6.2 纸飞机方案", explicitPaths: [], includeUnrefined: false } as never);
    assert.equal(JSON.parse(chat.providerResourceText).sources[0].sourceType, "notes");
    assert.equal(chat.retrieval.coverage?.scannedFiles, 3);
    bindings.roles.journal.searchEnabled = false;
    assert.equal((await index.search({ query: "莫干山" })).hits.length, 0);
    await assert.rejects(() => retriever.readAgentIndex({ vaultRelativePath: "日记/2026-09-20.md" }));
    bindings.roles.projects.enabled = false;
    assert.equal(knowledgeSearchPathKind("项目/决定.md", bindings), null);
    assert.equal(knowledgeSearchPathKind("模板/模版.md", bindings), null);
    assert.equal(knowledgeSearchPathKind(".echoink/private.md", bindings), null);
    assert.equal(knowledgeSearchPathKind("私有/记忆.md", bindings, ["私有"]), null);
    const recent = await index.search({ mode: "recent" });
    assert(recent.hits.every(hit => hit.kind === "notes"));
    assert.equal(recent.hits.some(hit => hit.vaultRelativePath.startsWith("项目/") || hit.vaultRelativePath.startsWith("日记/")), false);
    bodies.set("随手记/单行.md", "甲".repeat(60_000) + "UNIQUE_MIDDLE_TARGET" + "乙".repeat(60_000));
    clock++; events.emit("create", file("随手记/单行.md"));
    const bounded = await retriever.retrieve({ question: "UNIQUE_MIDDLE_TARGET" });
    assert.equal(bounded.references.length, 1);
    const span = bounded.references[0];
    assert(span.excerpt.length <= 3200 && span.excerpt.includes("UNIQUE_MIDDLE_TARGET"));
    assert(span.columnStart! > 0 && span.columnEnd! > span.columnStart!);
    assert.equal((await retriever.verifyReferences([span])).status, "valid", "unchanged bounded single-line evidence verifies against its columns");
    assert.equal(knowledgeReferenceEntryDetails([span]).references[0].columnStart, span.columnStart);
    const boundedChat = await production.retrieveChat!({ question: "UNIQUE_MIDDLE_TARGET", explicitPaths: [], includeUnrefined: false } as never);
    assert.equal(boundedChat.references.length, 1, "bounded source survives the production resource budget");
    const captured: import("../harness/pi-native/contracts").PiKnowledgeReference[] = [];
    const security = new PiKnowledgeReadToolSecurity({ currentRunIdentity: () => ({ vaultId: "v", conversationId: "c", piSessionId: "s", productRunId: "r" }), currentWorkflow: () => "chat", onSourceRead: reference => captured.push(reference), egress: new EchoInkVaultToolEgressPolicy() });
    const tools = createPiKnowledgeReadToolDefinitions({ retriever, security });
    const searchInput = { query: "UNIQUE_MIDDLE_TARGET", limit: 1 };
    await security.handleToolCall({ toolName: "knowledge_search", toolCallId: "bounded-search", input: searchInput } as never, undefined);
    await tools[0].execute("bounded-search", searchInput, undefined, undefined);
    const secured = await security.handleToolResult({ toolName: "knowledge_search", toolCallId: "bounded-search", isError: false } as never);
    assert.equal(secured.isError, false); assert.equal(captured.length, 1);
    assert.equal(captured[0].columnStart, span.columnStart);
    assert.equal((await retriever.verifyReferences(captured.map(reference => ({ ...reference })))).status, "valid");
    const readInput = { vaultRelativePath: span.vaultRelativePath, expectedContentRevision: span.contentRevision, lineStart: span.lineStart, lineCount: 1, columnStart: span.columnStart, columnEnd: span.columnEnd };
    await security.handleToolCall({ toolName: "knowledge_read", toolCallId: "bounded-read", input: readInput } as never, undefined);
    await tools[1].execute("bounded-read", readInput, undefined, undefined);
    const readResult = await security.handleToolResult({ toolName: "knowledge_read", toolCallId: "bounded-read", isError: false } as never);
    assert.equal(readResult.isError, false); assert.equal(captured[1].excerpt, span.excerpt);
    assert.equal(captured[1].referenceId, span.referenceId);
    bodies.set("随手记/完好.md", "# 完好\nLOCAL_FAILURE_QUERY仍可交付。");
    bodies.set("随手记/消失.md", "# 消失\nLOCAL_FAILURE_QUERY删除后不交付。");
    const originalSearch = port.search.bind(port);
    port.search = async request => { const found = await originalSearch(request); if (request.query === "LOCAL_FAILURE_QUERY") bodies.delete("随手记/消失.md"); return found; };
    const partial = await retriever.retrieve({ question: "LOCAL_FAILURE_QUERY" });
    assert(partial.references.some(reference => reference.vaultRelativePath === "随手记/完好.md"));
    assert(partial.localIssues?.some(issue => issue.vaultRelativePath === "随手记/消失.md" && issue.status === "not-found"));
    port.search = originalSearch;
    const old = preflight.references[0];
    bodies.set(old.vaultRelativePath, "# 新内容\nMUTATED_BODY_TOKEN"); clock++;
    events.emit("modify", file(old.vaultRelativePath));
    assert.equal((await retriever.verifyReferences([old])).status, "source_changed");
    await assert.rejects(() => index.search({ query: "2.6.2 纸飞机方案", cursor: result.continuationCursor! }), /stale/u);
    assert.equal((await index.search({ query: "MUTATED_BODY_TOKEN" })).hits.length, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => index.search({ query: "any", signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(() => production.retrieveChat!({ question: "any", explicitPaths: [], includeUnrefined: false, signal: controller.signal } as never), { name: "AbortError" });
    await assert.rejects(() => index.related({ vaultRelativePath: "项目/决定.md" }), /outside the search scope/u);
    const graph = index as unknown as { current: unknown; relations: Map<string, unknown[]>; relationPage(path: string, limit: number): { items: unknown[] } };
    graph.current = { generation: 1, entries: { "知识/允许.md": { contentRevision: span.contentRevision } } };
    graph.relations = new Map([["知识/允许.md", [{ direction: "outgoing", source: { vaultRelativePath: "知识/允许.md" }, target: { vaultRelativePath: "项目/决定.md" }, status: "available" }]]]);
    assert.equal(graph.relationPage("知识/允许.md", 8).items.length, 0, "related targets obey the same disabled scope");
  } finally { unbind(); }
  console.log("Public Vault body search, scope, delivery, events and freshness: PASS");
}
