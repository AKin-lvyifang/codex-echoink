import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { VaultBodySearch, knowledgeSearchPathKind } from "../knowledge-base/vault-body-search";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { KnowledgeRetriever, formatKnowledgeReferencesForPrompt } from "../knowledge-base/query";
import { bindKnowledgeIndexToVault, createProductionPiKnowledgeRuntime } from "../plugin/pi-production-runtime-composition";
import { PiKnowledgeReadToolSecurity, createPiKnowledgeReadToolDefinitions } from "../harness/pi-native/pi-knowledge-read-tools";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { knowledgeReferenceEntryDetails } from "../knowledge-base/usage";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";

export async function runVaultBodySearchMetadataTests(): Promise<void> {
  const paragraph = "Keep the amber filter in the upper drawer.\nCheck the spare lens before departure.";
  const bodies = new Map([
    ["notes/Field kit.md", `---\naliases: [Copper Beacon]\ntags: [reserve-batch]\n---\n\n# Field kit\n\n${paragraph}\n\n## Archive\nThe earlier packing list is obsolete.`]
  ]);
  const file = (path: string) => ({ path, basename: "Field kit", extension: "md", stat: { mtime: 20, ctime: 1, size: bodies.get(path)!.length } }) as TFile;
  const app = { vault: {
    getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => bodies.get(source.path)!
  }, metadataCache: { getFileCache: () => ({ frontmatter: { aliases: ["Copper Beacon"], tags: ["reserve-batch"] } }) },
  workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const port = new VaultBodySearch(app, () => emptyKnowledgeFolderBindings());
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-metadata-search", storageRootPath: "/synthetic-metadata-state", bodySearch: port });
  const retriever = new KnowledgeRetriever(index.vaultPath, { agentIndex: index });
  const production = createProductionPiKnowledgeRuntime({ vaultRootPath: index.vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
  try {
    for (const [query, source] of [["Field kit", "title"], ["Copper Beacon", "alias"], ["reserve-batch", "tag"]] as const) {
      const search = await index.search({ query, limit: 1 });
      assert.equal(search.hits[0].excerpt, paragraph);
      assert.equal(search.hits[0].lineStart, 8);
      assert.equal(search.hits[0].lineEnd, 9);
      assert.deepEqual(search.hits[0].matchSources, [source]);
      const retrieval = await retriever.retrieve({ question: query, limit: 1 });
      assert.equal(retrieval.references.length, 1);
      assert.equal(retrieval.references[0].excerpt, paragraph);
      assert.deepEqual(retrieval.references[0].matchSources, [source]);
      assert.equal((await retriever.verifyReferences(retrieval.references)).status, "valid");
      const reference = retrieval.references[0];
      const recorded = knowledgeReferenceEntryDetails([reference]).references[0];
      assert.deepEqual(recorded.matchSources, [source]);
      assert.equal(recorded.referenceId, reference.referenceId, "provenance does not change body-range identity");
      const { matchSources: _matchSources, ...legacy } = reference;
      assert.equal(Object.hasOwn(knowledgeReferenceEntryDetails([legacy]).references[0], "matchSources"), false, "legacy references remain valid without provenance");
      for (const matchSources of [[], ["body", "alias", "title", "tag", "alias"]] as const) {
        const normalized = knowledgeReferenceEntryDetails([{ ...reference, matchSources }]).references[0];
        assert.deepEqual(normalized.matchSources, matchSources, "valid provenance arrays retain their original order and entries");
        assert.equal(Object.isFrozen(normalized.matchSources), true);
      }
      for (const matchSources of ["title", null, undefined, ["unknown"], ["body", 1], ["Alias"], new Array(1)]) {
        assert.throws(() => knowledgeReferenceEntryDetails([{ ...reference, matchSources } as never]), /matchSources 无效/u);
      }
      const result = await production.retrieveChat!({ question: query, explicitPaths: [], includeUnrefined: false } as never);
      const delivered = JSON.parse(result.providerResourceText).sources[0];
      assert.equal(delivered.excerpt, paragraph);
      assert.equal(delivered.lineStart, 8);
      assert.deepEqual(delivered.matchSources, [source], "production preflight JSON retains the actual matching field");
      assert.equal(delivered.contentRevision, retrieval.references[0].contentRevision);
    }
  } finally { port.dispose(); }
  console.log("Public Vault metadata evidence: verified search/preflight JSON, strict provenance storage and legacy compatibility PASS");
}

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
    assert.equal(chat.retrieval.coverage?.scannedFiles, 0);
    assert.equal(chat.retrieval.coverage?.cachedFiles, 3);
    assert.equal(chat.retrieval.coverage?.indexedFiles, 3);
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

export async function runVaultBodySearchCacheTests(): Promise<void> {
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.projects.enabled = true; bindings.roles.projects.readPaths = ["项目"];
  bindings.roles.templates.enabled = true; bindings.roles.templates.readPaths = ["模板"];
  bindings.roles.work.enabled = false; bindings.roles.work.readPaths = ["禁用"];
  const bodies = new Map([["普通/A.md", "# A\nCACHE_ALPHA"], ["项目/B.md", "# B\nCACHE_ALPHA"],
    ["私有/Memory.md", "private"], ["模板/T.md", "template"], ["禁用/W.md", "disabled"]]);
  const metadata = new Map<string, unknown>();
  const vaultEvents = new EventEmitter(), metadataEvents = new EventEmitter();
  let reads = 0;
  const failed = new Set<string>();
  let pause: (() => Promise<void>) | undefined;
  const file = (path: string) => ({ path, basename: path.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: 1, size: bodies.get(path)?.length ?? 0 } }) as TFile;
  const hostEvents = (events: EventEmitter) => ({
    on: (name: string, callback: (...args: unknown[]) => void) => { events.on(name, callback); return { name, callback }; },
    offref: ({ name, callback }: { name: string; callback: (...args: unknown[]) => void }) => { events.off(name, callback); }
  });
  const app = { vault: { ...hostEvents(vaultEvents), getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => { reads++; await pause?.(); if (failed.has(source.path) || !bodies.has(source.path)) throw new Error("unreadable"); return bodies.get(source.path)!; }
  }, metadataCache: { ...hostEvents(metadataEvents), getFileCache: (source: TFile) => metadata.get(source.path) ?? null },
  workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings, { excludedRoots: () => ["私有"] });
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-cache", storageRootPath: "/synthetic-cache-state", bodySearch: port });
  const release = bindKnowledgeIndexToVault(app, index);
  try {
    const cold = await index.search({ query: "CACHE_ALPHA", limit: 1 });
    assert.deepEqual(cold.coverage, { totalFiles: 2, scannedFiles: 2, readFiles: 2, cachedFiles: 0, indexedFiles: 2, failedFiles: 0, complete: true, unknownJournalDates: 0 });
    const warm = await index.search({ query: "CACHE_ALPHA", limit: 1 });
    assert.deepEqual(warm.hits, cold.hits);
    assert.equal(warm.coverage?.readFiles, 0); assert.equal(warm.coverage?.cachedFiles, 2); assert.equal(reads, 2);
    const another = await index.search({ query: "CACHE_OTHER" });
    assert.equal(another.coverage?.cachedFiles, 2); assert.equal(reads, 2, "different query reuses full statistics");
    // Production subscriptions must ignore paths outside this search authority.
    port.invalidate("普通/A.md");
    let scanEntered!: () => void, scanResume!: () => void;
    const scanStarted = new Promise<void>(resolve => { scanEntered = resolve; });
    const scanGate = new Promise<void>(resolve => { scanResume = resolve; });
    pause = async () => { scanEntered(); await scanGate; };
    const liveSearch = index.search({ query: "CACHE_ALPHA", limit: 1 });
    await scanStarted;
    for (const path of ["私有/Memory.md", "模板/T.md", "禁用/W.md", ".cache/hidden.md"]) {
      vaultEvents.emit("modify", file(path)); metadataEvents.emit("changed", file(path));
    }
    vaultEvents.emit("rename", { path: "私有", children: [] }, ".private-old");
    scanResume();
    const unaffected = await liveSearch;
    assert.equal(unaffected.coverage?.complete, true, "an unrelated event cannot fail a fresh query with no cursor");
    pause = undefined;
    vaultEvents.emit("create", file("模板/T.md"));
    vaultEvents.emit("delete", file("私有/Memory.md"));
    assert.equal((await index.search({ query: "CACHE_ALPHA", limit: 1, cursor: unaffected.continuationCursor })).returned, 1, "an old cursor remains valid across excluded events");
    let readEntered!: () => void, readResume!: () => void;
    const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
    const readGate = new Promise<void>(resolve => { readResume = resolve; });
    pause = async () => { readEntered(); await readGate; };
    const reading = port.read({ vaultRelativePath: "普通/A.md" });
    await readStarted; vaultEvents.emit("modify", file("项目/B.md")); readResume();
    assert.equal((await reading).content, bodies.get("普通/A.md"), "another searchable source changing does not invalidate this source read");
    pause = undefined;
    await index.search({ query: "CACHE_ALPHA" });
    // Same mtime and same length: the production modify event is the freshness authority.
    bodies.set("普通/A.md", "# A\nCACHE_OMEGA"); vaultEvents.emit("modify", file("普通/A.md"));
    const modified = await index.search({ query: "CACHE_OMEGA" });
    assert.equal(modified.hits[0].vaultRelativePath, "普通/A.md"); assert.equal(modified.coverage?.readFiles, 1); assert.equal(modified.coverage?.cachedFiles, 1);
    await assert.rejects(() => port.read({ vaultRelativePath: cold.hits[0].vaultRelativePath, expectedContentRevision: cold.hits[0].contentRevision }), /changed/u);
    await assert.rejects(() => index.search({ query: "CACHE_ALPHA", cursor: cold.continuationCursor! }), /stale/u);
    const metadataQuery = { queries: ["CACHE_ALPHA", "CACHE_OMEGA"], limit: 1 };
    const beforeMetadata = await index.search(metadataQuery);
    metadata.set("普通/A.md", { frontmatter: { aliases: ["星河计划"], tags: ["观察"] } });
    metadataEvents.emit("changed", file("普通/A.md"));
    const alias = await index.search({ query: "星河计划" });
    assert.equal(alias.hits[0].vaultRelativePath, "普通/A.md"); assert.equal(alias.coverage?.readFiles, 2, "dictionary changes rebuild affected tokenization view");
    await assert.rejects(() => index.search({ ...metadataQuery, cursor: beforeMetadata.continuationCursor! }), /stale/u);
    // Fresh metadata enumeration also catches a missed metadata notification.
    metadata.set("普通/A.md", { frontmatter: { aliases: ["月海计划"] } });
    assert.equal((await index.search({ query: "月海计划" })).hits[0].vaultRelativePath, "普通/A.md");
    bodies.set("普通/C.md", "# C\nCREATED_TOKEN"); vaultEvents.emit("create", file("普通/C.md"));
    assert.equal((await index.search({ query: "CREATED_TOKEN" })).hits[0].vaultRelativePath, "普通/C.md");
    bodies.set("普通/D.md", bodies.get("普通/C.md")!); bodies.delete("普通/C.md"); vaultEvents.emit("rename", file("普通/D.md"), "普通/C.md");
    assert.equal((await index.search({ query: "CREATED_TOKEN" })).hits[0].vaultRelativePath, "普通/D.md");
    bodies.set("新目录/D.md", bodies.get("普通/D.md")!); bodies.delete("普通/D.md"); vaultEvents.emit("rename", { path: "新目录", children: [] }, "普通");
    assert.equal((await index.search({ query: "CREATED_TOKEN" })).hits[0].vaultRelativePath, "新目录/D.md");
    bodies.delete("新目录/D.md"); vaultEvents.emit("delete", file("新目录/D.md"));
    assert.equal((await index.search({ query: "CREATED_TOKEN" })).hits.length, 0);
    bindings.roles.projects.searchEnabled = false;
    assert.equal((await index.search({ query: "CACHE_ALPHA" })).hits.length, 0);
    bindings.roles.projects.searchEnabled = true;
    assert.equal((await index.search({ query: "CACHE_ALPHA" })).hits[0].vaultRelativePath, "项目/B.md");
    failed.add("项目/B.md"); vaultEvents.emit("modify", file("项目/B.md"));
    const partial = await index.search({ query: "CACHE_ALPHA" });
    assert.equal(partial.coverage?.complete, false); assert.equal(partial.coverage?.failedFiles, 1); assert.equal(partial.coverage?.indexedFiles, 1);
    failed.clear(); assert.equal((await index.search({ query: "CACHE_ALPHA" })).coverage?.readFiles, 1);
    const recent = await index.search({ mode: "recent", limit: 1 });
    assert.equal(recent.coverage?.readFiles, 1); assert.equal(recent.coverage?.cachedFiles, 0); assert.equal(recent.coverage?.indexedFiles, 1); assert.equal(recent.coverage?.complete, false);
    const recentEnd = await index.search({ mode: "recent", limit: 1, cursor: recent.continuationCursor });
    assert.equal(recentEnd.exhausted, true); assert.equal(recentEnd.coverage?.complete, false, "last page does not claim all bodies were read in this request");
    port.invalidate();
    let started!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    pause = async () => { started(); await gate; };
    const pending = index.search({ query: "CACHE_ALPHA" });
    await entered; bindings.roles.projects.searchEnabled = false; resume();
    await assert.rejects(pending, /scope changed/u);
    pause = undefined;
    assert.equal((await index.search({ query: "CACHE_ALPHA" })).hits.length, 0);
    release(); release();
    assert.equal(vaultEvents.listenerCount("modify"), 0); assert.equal(metadataEvents.listenerCount("changed"), 0);
    const before = reads;
    await assert.rejects(() => port.search({ query: "any" }), /disposed/u);
    await assert.rejects(() => port.read({ vaultRelativePath: "普通/A.md" }), /disposed/u);
    assert.equal(reads, before);
  } finally { release(); }
  console.log("Public Vault memory reuse, production events, scope, partial failure and disposal: PASS");
}

export async function runVaultBodySearchConcurrencyTests(): Promise<void> {
  const requests = [{ query: "alpha" }, { query: "beta", kinds: ["wiki"] as const }, { query: "gamma", kinds: ["journal"] as const }];
  for (const warm of [false, true]) {
    const bindings = emptyKnowledgeFolderBindings();
    bindings.roles.wiki.enabled = true; bindings.roles.wiki.readPaths = ["知识"];
    bindings.roles.journal.enabled = true; bindings.roles.journal.readPaths = ["日记"];
    const bodies = new Map([
      ["普通/陶艺安排.md", "# 陶艺\nalpha beta gamma"],
      ["知识/湿地观察.md", "# 湿地\nalpha beta gamma"],
      ["日记/2026-10-01.md", "# 日记\nalpha beta gamma"],
    ]);
    const metadata = new Map<string, unknown>();
    const vaultEvents = new EventEmitter(), metadataEvents = new EventEmitter();
    let eventCount = 0, activeReads = 0, maxActiveReads = 0;
    let pause: Promise<void> | undefined;
    const file = (relativePath: string) => ({ path: relativePath, basename: relativePath.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: 1, size: bodies.get(relativePath)?.length ?? 0 } }) as TFile;
    const hostEvents = (events: EventEmitter) => ({
      on: (name: string, callback: (...args: unknown[]) => void) => { events.on(name, callback); return { name, callback }; },
      offref: ({ name, callback }: { name: string; callback: (...args: unknown[]) => void }) => { events.off(name, callback); },
    });
    const app = { vault: { ...hostEvents(vaultEvents), getMarkdownFiles: () => [...bodies.keys()].map(file),
      getAbstractFileByPath: (relativePath: string) => bodies.has(relativePath) ? file(relativePath) : null,
      read: async (source: TFile) => {
        const content = bodies.get(source.path)!;
        activeReads++; maxActiveReads = Math.max(maxActiveReads, activeReads);
        try { await pause; return content; } finally { activeReads--; }
      },
    }, metadataCache: { ...hostEvents(metadataEvents), getFileCache: (source: TFile) => metadata.get(source.path) ?? null } } as unknown as App;
    const baselinePort = new VaultBodySearch(app, () => bindings);
    const expected = [];
    for (const request of requests) expected.push(await baselinePort.search(request));
    baselinePort.dispose();
    const port = new VaultBodySearch(app, () => bindings);
    const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-concurrent", storageRootPath: "/synthetic-concurrent-state", bodySearch: port });
    const release = bindKnowledgeIndexToVault(app, index);
    const startTogether = async (input: typeof requests, signal?: AbortSignal) => {
      let resume!: () => void;
      pause = new Promise<void>(resolve => { resume = resolve; });
      maxActiveReads = 0;
      const pending = input.map((request, i) => index.search({ ...request, ...(i === 0 && signal ? { signal } : {}) }));
      // Observe blocked public reads, rather than inferring overlap from elapsed time.
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      return { pending, resume: () => { pause = undefined; resume(); } };
    };
    try {
      if (warm) await index.search(requests[0]);
      const together = await startTogether(requests);
      assert.ok(maxActiveReads >= 2, "independent searches are not globally serialized");
      together.resume();
      const actual = await Promise.all(together.pending);
      actual.forEach((result, i) => {
        assert.deepEqual(result.hits, expected[i].hits);
        assert.equal(result.coverage?.complete, true);
      });
      assert.equal(eventCount, 0, "static synthetic data has no host events during cold/warm mixed-view searches");
      const page = await index.search({ query: "alpha", limit: 1 });
      assert.ok(page.continuationCursor);
      await Promise.all(requests.map(request => index.search(request)));
      assert.equal((await index.search({ query: "alpha", limit: 1, cursor: page.continuationCursor })).generation, page.generation, "internal cache replacement preserves old cursors");

      const cancel = new AbortController();
      port.invalidate();
      const cancelling = await startTogether(requests, cancel.signal);
      cancel.abort(); cancelling.resume();
      const cancelled = await Promise.allSettled(cancelling.pending);
      assert.equal(cancelled[0].status, "rejected");
      if (cancelled[0].status === "rejected") assert.equal(cancelled[0].reason.name, "AbortError");
      assert.equal(cancelled[1].status, "fulfilled"); assert.equal(cancelled[2].status, "fulfilled");

      for (const change of ["body", "metadata", "scope"] as const) {
        port.invalidate();
        const changing = await startTogether(requests);
        if (change === "body") {
          bodies.set("普通/陶艺安排.md", "# 陶艺\nomega beta gamma");
          eventCount++; vaultEvents.emit("modify", file("普通/陶艺安排.md"));
        } else if (change === "metadata") {
          metadata.set("知识/湿地观察.md", { frontmatter: { aliases: ["新湿地别名"] } });
          eventCount++; metadataEvents.emit("changed", file("知识/湿地观察.md"));
        } else bindings.roles.wiki.searchEnabled = false;
        changing.resume();
        const changed = await Promise.allSettled(changing.pending);
        assert.ok(changed.every(result => result.status === "rejected" && result.reason.code === "source_changed"), "real body/metadata/scope changes still reject old snapshots without silent retries");
      }
      await assert.rejects(index.search({ query: "alpha", cursor: page.continuationCursor }), { code: "cursor_stale" });
      assert.equal((await index.search({ query: "新湿地别名" })).hits.length, 0, "disabled sources stay excluded after concurrent changes");
    } finally { pause = undefined; release(); }
  }

  // The legacy relation index needs real files. Keep this owned synthetic fixture in
  // the worktree; no native Obsidian Vault or operating-system temp Vault is used.
  const temporaryRoot = path.join(process.cwd(), ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, "body-search-related-"));
  const bindings = emptyKnowledgeFolderBindings();
  bindings.configured = true; bindings.revision = 1;
  bindings.roles.wiki.enabled = true; bindings.roles.wiki.readPaths = ["知识"];
  const bodies = new Map([["知识/A.md", "# A\nalpha [[B]]"], ["知识/B.md", "# B\nalpha [[A]]"]]);
  await mkdir(path.join(root, "知识"));
  for (const [relativePath, content] of bodies) await writeFile(path.join(root, relativePath), content);
  const unregister = registerKnowledgeFolderBindings(root, () => bindings);
  try {
    for (const warm of [false, true]) {
      let resume!: () => void, entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; });
      let blocked = !warm;
      const file = (relativePath: string) => ({ path: relativePath, basename: relativePath.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: 1, size: bodies.get(relativePath)!.length } }) as TFile;
      const app = { vault: { getMarkdownFiles: () => [...bodies.keys()].map(file), getAbstractFileByPath: (relativePath: string) => bodies.has(relativePath) ? file(relativePath) : null,
        read: async (source: TFile) => { if (blocked) { entered(); await gate; } return bodies.get(source.path)!; },
      }, metadataCache: { getFileCache: () => null } } as unknown as App;
      const port = new VaultBodySearch(app, () => bindings);
      const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, warm ? "state-warm" : "state-cold"), bodySearch: port });
      try {
        if (warm) await port.search({ query: "alpha" });
        const normal = index.search({ query: "alpha" });
        if (!warm) await started;
        const relations = await Promise.all([index.related({ vaultRelativePath: "知识/A.md" }), index.related({ vaultRelativePath: "知识/B.md" })]);
        assert.ok(relations.every(result => result.items.length > 0));
        blocked = false; resume();
        assert.equal((await normal).hits.length, 2, "first relation-index initialization cannot clear an independent body search");
        assert.equal((await port.search({ query: "alpha" })).coverage?.cachedFiles, 2);
      } finally { blocked = false; resume(); port.dispose(); }
    }
  } finally { unregister(); await rm(root, { recursive: true, force: true }); }
  console.log("Public Vault concurrency: cold/warm independent views, cancellation, real events, cursors and first related initialization PASS");
}
