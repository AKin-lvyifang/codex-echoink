import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TFile, type App } from "obsidian";
import { collectChatKnowledgeCandidates } from "../knowledge-base/chat-knowledge-candidates";
import { KnowledgeAgentIndex, type KnowledgeAgentSearchHit } from "../knowledge-base/knowledge-agent-index";
import { BodySearchMemoryIndex } from "../knowledge-base/search/body-search";
import type { BodySearchDocument, KnowledgeCandidateSearch } from "../knowledge-base/search/contracts";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { VaultBodySearch } from "../knowledge-base/vault-body-search";

export async function runChatKnowledgeCandidateSearchTests(): Promise<void> {
  await rankingAndDefaultCompatibility();
  await deadlineCacheAndCancellation();
  await deadlineStopsProductionWork();
  console.log("Chat candidate search: PASS (ranking, default navigation/10KB, deadline cache, cancellation; in-memory host only).");
}

async function rankingAndDefaultCompatibility(): Promise<void> {
  const bodies = new Map<string, string>();
  const body = (index: number) => `# Opening\nneedle ${"background ".repeat(100)}\n\n## Chapter\nneedle ${"background ".repeat(100)}\n${index < 2 ? "[[Guide#Details]]" : ""}`;
  for (let index = 0; index < 15; index++) bodies.set(`00-withdrawn/${String(index).padStart(2, "0")}.md`, body(index));
  for (let index = 0; index < 35; index++) bodies.set(`10-allowed/${String(index).padStart(2, "0")}.md`, body(index + 15));
  bodies.set("Guide.md", "# Guide\n## Details\nNavigation only.");
  bodies.set("private/secret.md", "needle forbidden body");
  const fixture = host(bodies);
  const bindings = emptyKnowledgeFolderBindings();
  bindings.inboxRecallExclusions = ["00-withdrawn"];
  const release = registerKnowledgeFolderBindings("/synthetic-chat-candidates", () => bindings);
  const port = new VaultBodySearch(fixture.app, () => bindings, { excludedRoots: () => ["private"], journalSettings: () => ({ folder: "journal", format: "YYYY-MM-DD", formatHistory: [] }) });
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-chat-candidates", storageRootPath: "/synthetic-chat-candidates-state", bodySearch: port });
  try {
    const first = await index.search({ query: "needle", limit: 50 });
    assert(first.hits.length < 50, "the unchanged public result is still compressed to 10KB");
    assert(Buffer.byteLength(JSON.stringify(first.hits)) <= 10_000);
    const navigationPage = await index.search({ query: "needle", limit: 1 });
    assert(navigationPage.hits.some(hit => hit.outline || hit.linkCues || hit.related), "ordinary search still delivers navigation when its page has room");
    const ranked: KnowledgeAgentSearchHit[] = [...first.hits];
    let cursor = first.continuationCursor;
    while (cursor) {
      const page = await index.search({ query: "needle", limit: 50, cursor });
      ranked.push(...page.hits);
      cursor = page.continuationCursor;
    }
    const expected: KnowledgeAgentSearchHit[] = [];
    const seen = new Set<string>();
    let inspected = 0;
    for (const hit of ranked.slice(0, 250)) {
      inspected++;
      if (hit.vaultRelativePath.startsWith("00-withdrawn/") || seen.has(hit.vaultRelativePath)) continue;
      seen.add(hit.vaultRelativePath); expected.push(hit);
      if (expected.length === 25) break;
    }
    const memory = (port as unknown as { memory: BodySearchMemoryIndex }).memory;
    const search = memory.search.bind(memory);
    let rankings = 0;
    memory.search = async options => { rankings++; return search(options); };
    const beforeReads = fixture.reads.length;
    const selected = await collectChatKnowledgeCandidates({ vaultPath: index.vaultPath, agentIndex: index, question: "needle", timeBudgetMs: 10_000 });
    assert.equal(rankings, 1, "candidate collection asks for one complete ranking");
    assert.equal(selected.pages, 1);
    assert.equal(selected.candidates.length, 25, "filtering and dedupe happen before the 25-note limit");
    assert.equal(selected.scannedHits, inspected);
    assert(selected.scannedHits > 25);
    assert.equal(selected.stopReason, "candidate_limit");
    assert.equal(fixture.reads.length, beforeReads, "warm candidate collection does no navigation verification rereads");
    assert(Buffer.byteLength(JSON.stringify(selected.candidates.map(candidate => candidate.hit))) > 10_000,
      "internal candidates are not truncated by the tool's JSON budget");
    assert.deepEqual(selected.candidates.map(candidate => evidence(candidate.hit)), expected.map(evidence));
    assert(selected.candidates.every(candidate => !candidate.hit.outline && !candidate.hit.linkCues && !candidate.hit.related));
    assert(!fixture.reads.includes("private/secret.md"));
    const after = await index.search({ query: "needle", limit: 50 });
    assert.deepEqual(after.hits, first.hits, "candidate use does not change default evidence/navigation/JSON fitting");
    assert.equal(after.continuationCursor, first.continuationCursor);
    const bounded = await collectChatKnowledgeCandidates({ vaultPath: index.vaultPath, agentIndex: index, question: "needle", maxScannedHits: 25, timeBudgetMs: 10_000 });
    assert.equal(bounded.scannedHits, 25);
    assert.equal(bounded.stopReason, "scan_budget");
    assert(bounded.candidates.length < 25);
  } finally { release(); port.dispose(); }
  console.log("Chat candidate search: one ranking matches old pages; filters, evidence, navigation and 10KB compatibility PASS");
}

async function deadlineCacheAndCancellation(): Promise<void> {
  const memory = new BodySearchMemoryIndex();
  let reads = 0;
  let stopOnSecond = true;
  const control = deadlineControl();
  const documents = [0, 1, 2].map(index => document(`${index}.md`, async () => {
    reads++;
    if (index === 1 && stopOnSecond) control.expire();
    return "# Chapter\nneedle authentic evidence";
  }));
  const cold = await memory.search({ documents, request: { query: "needle", signal: control.signal, candidateSearch: control.options } });
  assert.equal(cold.candidateSearch?.stopReason, "time_budget");
  assert.equal(cold.hits.length, 0, "a partial corpus is never exposed as the complete ranking");
  assert.equal(cold.coverage.complete, false);
  assert.equal(cold.coverage.indexedFiles, 1);
  stopOnSecond = false;
  reads = 0;
  const retry = await memory.search({ documents, request: { query: "needle", limit: 10 } });
  assert.equal(retry.coverage.cachedFiles, 1, "the first complete file survives a candidate deadline");
  assert.equal(reads, 2, "retry continues warming rather than starting from zero");
  const retainedRevision = retry.hits.find(hit => hit.vaultRelativePath === "0.md")!.contentRevision;
  assert.deepEqual(memory.navigationLinks("0.md", retainedRevision), { links: [], total: 0 },
    "retained statistics include the completed navigation cache, even for a short note without an outline");

  const userIndex = new BodySearchMemoryIndex();
  const user = deadlineControl();
  let cancel = true;
  const userDocuments = [0, 1, 2].map(index => document(`${index}.md`, async () => {
    if (index === 1 && cancel) user.cancel();
    return "needle";
  }));
  await assert.rejects(userIndex.search({ documents: userDocuments, request: { query: "needle", signal: user.signal, candidateSearch: user.options } }), { name: "AbortError" });
  cancel = false;
  const afterCancel = await userIndex.search({ documents: userDocuments, request: { query: "needle" } });
  assert.equal(afterCancel.coverage.cachedFiles, 0, "user cancellation still discards this request's staged records");

  const ordinaryIndex = new BodySearchMemoryIndex();
  const ordinaryAbort = new AbortController();
  let ordinaryCancel = true;
  const ordinaryDocuments = [0, 1].map(index => document(`${index}.md`, async () => {
    if (index === 1 && ordinaryCancel) ordinaryAbort.abort();
    return "needle";
  }));
  await assert.rejects(ordinaryIndex.search({ documents: ordinaryDocuments, request: { query: "needle", signal: ordinaryAbort.signal } }), { name: "AbortError" });
  ordinaryCancel = false;
  assert.equal((await ordinaryIndex.search({ documents: ordinaryDocuments, request: { query: "needle" } })).coverage.cachedFiles, 0,
    "ordinary no-flag cancellation keeps the existing transactional cache behavior");

  const invalidatedIndex = new BodySearchMemoryIndex();
  const invalidated = deadlineControl();
  let invalidate = true;
  const invalidatedDocuments = [0, 1].map(index => document(`${index}.md`, async () => {
    if (index === 1 && invalidate) { invalidatedIndex.invalidate("0.md"); invalidated.expire(); }
    return "needle";
  }));
  await assert.rejects(invalidatedIndex.search({ documents: invalidatedDocuments, request: { query: "needle", signal: invalidated.signal, candidateSearch: invalidated.options } }), { code: "search_index_stale" });
  invalidate = false;
  assert.equal((await invalidatedIndex.search({ documents: invalidatedDocuments, request: { query: "needle" } })).coverage.cachedFiles, 0);

  const partialControl = deadlineControl();
  let examined = 0;
  const partial = await memory.search({ documents, request: { query: "needle", signal: partialControl.signal,
    candidateSearch: { ...partialControl.options, allowsPath: () => { if (++examined === 2) partialControl.expire(); return true; } } } });
  assert.equal(partial.candidateSearch?.stopReason, "time_budget");
  assert(partial.hits.length > 0 && partial.hits.length < 3, "already materialized candidates come only from a complete ordering");
  const longIndex = new BodySearchMemoryIndex();
  const longDeadline = deadlineControl();
  const scheduler = Object.getOwnPropertyDescriptor(globalThis, "scheduler");
  let laterRead = false;
  Object.defineProperty(globalThis, "scheduler", { configurable: true, value: { yield: async () => { longDeadline.expire(); } } });
  try {
    const interrupted = await longIndex.search({ documents: [
      document("first.md", async () => "needle first complete record"),
      document("long.md", async () => `needle ${"long background ".repeat(15_000)}`),
      document("later.md", async () => { laterRead = true; return "needle later"; })
    ], request: { query: "needle", signal: longDeadline.signal, candidateSearch: longDeadline.options } });
    assert.equal(interrupted.candidateSearch?.stopReason, "time_budget");
    assert.equal(interrupted.coverage.indexedFiles, 1, "an interrupted individual file never becomes a completed record");
    assert.equal(laterRead, false, "a cooperative tokenizer deadline stops before later files");
  } finally {
    if (scheduler) Object.defineProperty(globalThis, "scheduler", scheduler);
    else Reflect.deleteProperty(globalThis, "scheduler");
    longIndex.dispose();
  }
  memory.dispose(); userIndex.dispose(); ordinaryIndex.dispose(); invalidatedIndex.dispose();
  console.log("Chat candidate search: cold deadline retains complete statistics; user cancellation/invalidation reject; partial ordered output PASS");
}

async function deadlineStopsProductionWork(): Promise<void> {
  const bodies = new Map(Array.from({ length: 100 }, (_, index) => [`notes/${index}.md`, "# Chapter\nneedle evidence"]));
  const fixture = host(bodies);
  let pathChecks = 0;
  const port = new VaultBodySearch(fixture.app, () => null, {
    journalSettings: () => ({ folder: "journal", format: "YYYY-MM-DD", formatHistory: [] }),
    resolveSourcePath: async relativePath => { pathChecks++; await new Promise(resolve => setTimeout(resolve, 20)); return relativePath; }
  });
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-chat-deadline", storageRootPath: "/synthetic-chat-deadline-state", bodySearch: port });
  try {
    const result = await collectChatKnowledgeCandidates({ vaultPath: index.vaultPath, agentIndex: index, question: "needle", timeBudgetMs: 5 });
    assert.equal(result.stopReason, "time_budget");
    assert.equal(result.candidates.length, 0);
    assert.equal(fixture.reads.length, 0, "deadline stops before body tokenization/ranking");
    assert(pathChecks > 0 && pathChecks <= 32);
    const settled = pathChecks;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(pathChecks, settled, "no abandoned metadata batch starts after returning");
    assert.equal(fixture.reads.length, 0);

    const cancel = new AbortController();
    const pending = collectChatKnowledgeCandidates({ vaultPath: index.vaultPath, agentIndex: index, question: "needle", signal: cancel.signal, timeBudgetMs: 100 });
    cancel.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { port.dispose(); }
  console.log("Chat candidate search: production deadline drains current I/O batch and stops later CPU work; user abort priority PASS");
}

function evidence(hit: KnowledgeAgentSearchHit) {
  const { outline: _outline, related: _related, linkCues: _linkCues, ...body } = hit;
  return body;
}

function document(vaultRelativePath: string, read: () => Promise<string>): BodySearchDocument {
  return { vaultRelativePath, title: vaultRelativePath, kind: "notes", recordedAt: 1, revisionKey: "stable",
    read: async () => { const content = await read(); return { content, contentRevision: `sha256:${createHash("sha256").update(content).digest("hex")}` }; } };
}

function deadlineControl() {
  const controller = new AbortController();
  let expired = false;
  let cancelled = false;
  const options: KnowledgeCandidateSearch = {
    maxCandidates: 25, maxScannedHits: 250, allowsPath: () => true,
    check: () => { if (controller.signal.aborted) throw Object.assign(new Error("stopped"), { name: "AbortError" }); },
    timedOut: () => expired && !cancelled
  };
  return { signal: controller.signal, options,
    expire: () => { expired = true; controller.abort(); }, cancel: () => { cancelled = true; controller.abort(); } };
}

function host(bodies: Map<string, string>) {
  const reads: string[] = [];
  const file = (relativePath: string) => Object.assign(new TFile(), {
    path: relativePath, basename: relativePath.split("/").at(-1)!.replace(/\.md$/u, ""), extension: "md",
    stat: { mtime: 1, ctime: 1, size: bodies.get(relativePath)!.length }
  }) as TFile;
  const app = { vault: {
    getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (relativePath: string) => bodies.has(relativePath) ? file(relativePath) : null,
    read: async (source: TFile) => { reads.push(source.path); return bodies.get(source.path)!; }
  }, metadataCache: { getFileCache: () => null }, workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  return { app, reads };
}
