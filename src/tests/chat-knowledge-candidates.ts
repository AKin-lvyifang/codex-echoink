import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { collectChatKnowledgeCandidates } from "../knowledge-base/chat-knowledge-candidates";
import type { KnowledgeAgentIndex, KnowledgeAgentSearchHit, KnowledgeAgentSearchRequest, KnowledgeAgentSearchResult } from "../knowledge-base/knowledge-agent-index";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { KNOWLEDGE_SEARCH_KINDS } from "../knowledge-base/search/contracts";
import { redactEchoInkLocalSecretsV1 } from "../security/local-secrets";

// Only in-memory search pages are used; this path is a registry key, not a Vault.
const VAULT_PATH = path.join(tmpdir(), `echoink-chat-candidates-in-memory-${process.pid}`);
type CandidateIndex = Pick<KnowledgeAgentIndex, "search" | "bodySearch">;

export async function runChatKnowledgeCandidatesTests(): Promise<void> {
  let cases = 0;
  const run = async (name: string, test: () => Promise<void>) => {
    await test();
    cases++;
    console.log(`Chat Knowledge candidates: ${name}: PASS`);
  };

  await run("empty question does not search", async () => {
    const source = fakeIndex([]);
    assert.deepEqual(await collect(source.index, { question: " \n\t " }), {
      candidates: [], scannedHits: 0, pages: 0, stopReason: "exhausted"
    });
    assert.equal(source.requests.length, 0);
  });

  await run("all ordinary-chat kinds and complete first-hit evidence survive", async () => {
    const first = hit("notes/first.md", {
      lineStart: 7, lineEnd: 9, columnStart: 3, columnEnd: 21, totalLines: 80,
      sectionTitle: "原始段落", subjects: ["主题"], applicableTime: "2026", documentKind: "记录",
      matchSources: ["body", "alias"], inclusionReason: "按指代带入",
      rawSources: [{ vaultRelativePath: "raw/original.md", contentRevision: "source-revision", status: "available" }],
      outline: { schemaVersion: 1, readStatus: "unread", contentRevision: "outline-revision", entries: [{ heading: "原始段落", level: 2, lineStart: 7, lineEnd: 12 }], totalHeadings: 1, truncated: false },
      linkCues: [{ schemaVersion: 1, readStatus: "unread", label: "可能相关", title: "导航", vaultRelativePath: "notes/link.md", via: [{ vaultRelativePath: "notes/first.md", contentRevision: "via-revision" }] }],
      related: { vaultRelativePath: "notes/first.md", contentRevision: "related-revision", total: 0, returned: 0, remaining: 0, hasMore: false, exhausted: true, items: [] }
    });
    const before = JSON.stringify(first);
    Object.freeze(first);
    const kinds = KNOWLEDGE_SEARCH_KINDS.map(kind => hit(`${kind}/scope.md`, { kind }));
    const source = fakeIndex([
      page([first, hit(first.vaultRelativePath, { entryId: "later-section", excerpt: "later excerpt" })], "p2"),
      page([hit(first.vaultRelativePath, { entryId: "later-page" }), ...kinds])
    ], () => true);
    const controller = new AbortController();
    const result = await collect(source.index, { question: "  普通问题  ", signal: controller.signal });
    assert.equal(result.stopReason, "exhausted");
    assert.equal(result.pages, 2);
    assert.equal(result.scannedHits, 3 + kinds.length);
    assert.deepEqual(result.candidates.map(candidate => candidate.hit.kind), ["notes", ...KNOWLEDGE_SEARCH_KINDS]);
    assert.strictEqual(result.candidates[0].hit, first, "retain the complete first-ranked object, not a DTO reconstruction");
    assert.equal(JSON.stringify(first), before, "candidate formatting must never mutate read-authority metadata");
    assert.deepEqual(result.candidates.map(candidate => candidate.note.id), result.candidates.map((_, index) => `n${index}`));
    for (const candidate of result.candidates) {
      assert.deepEqual(Object.keys(candidate.note).sort(), ["excerpt", "id", "title"]);
    }
    for (const request of source.requests) {
      assert.equal(request.query, "普通问题");
      assert(request.signal, "the collector supplies its cooperative deadline signal");
      assert.equal(request.signal.aborted, false);
      assert.equal(request.kinds, undefined, "do not introduce ask/maintain scope restrictions");
      assert.equal(request.mode, undefined);
      assert.equal(request.excludePaths, undefined);
      assert(request.limit! <= 50);
    }
    assert.equal(source.requests[1].cursor, "p2");
    assert.equal(source.reads.count, 0, "no reference builder, index read, or body read in the candidate stage");
  });

  await run("private and withdrawn paths are filtered before dedupe, then pages refill", async () => {
    const bindings = emptyKnowledgeFolderBindings();
    bindings.roles.inbox.readPaths = ["inbox"];
    bindings.inboxRecallExclusions = ["withdrawn"];
    bindings.onboardingGuidePath = "notes/setup.md";
    Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["withdrawn/shared"], writePath: "withdrawn/shared" });
    const release = registerKnowledgeFolderBindings(VAULT_PATH, () => bindings);
    const allowedChecks: string[] = [];
    const firstAllowed = hit("notes/allowed.md");
    const shared = hit("withdrawn/shared/allowed.md", { kind: "raw" });
    const last = hit("notes/last.md");
    const source = fakeIndex([
      page([hit("private/blocked.md"), hit("inbox/blocked.md"), hit("withdrawn/blocked.md"), hit("notes/setup.md")], "p2"),
      page([firstAllowed, hit(firstAllowed.vaultRelativePath), shared], "p3"),
      page([last])
    ], relativePath => { allowedChecks.push(relativePath); return !relativePath.startsWith("private/"); });
    try {
      const result = await collect(source.index, { maxCandidates: 3 });
      assert.deepEqual(result.candidates.map(candidate => candidate.hit), [firstAllowed, shared, last]);
      assert.equal(result.pages, 3);
      assert.equal(result.scannedHits, 8);
      assert.equal(result.stopReason, "candidate_limit");
      assert(allowedChecks.filter(value => value === firstAllowed.vaultRelativePath).length >= 2,
        "duplicate hits still pass the path filter");
      assert.equal(source.reads.count, 0);
    } finally { release(); }
  });

  await run("filtered first occurrence cannot suppress a later permitted hit", async () => {
    const earlier = hit("notes/change.md", { entryId: "earlier-filtered" });
    const later = hit(earlier.vaultRelativePath, { entryId: "later-permitted" });
    let permitted = false;
    const source = fakeIndex((_request, index) => {
      if (index === 0) return page([earlier], "p2");
      permitted = true;
      return page([later]);
    }, () => permitted);
    const result = await collect(source.index);
    assert.strictEqual(result.candidates[0].hit, later);
    assert.equal(result.scannedHits, 2);
  });

  await run("scope withdrawn during a later page is removed and ids are compacted", async () => {
    const bindings = emptyKnowledgeFolderBindings();
    Object.assign(bindings.roles.inbox, { enabled: true, readPaths: ["inbox"], writePath: "inbox" });
    const release = registerKnowledgeFolderBindings(VAULT_PATH, () => bindings);
    const bodyRevoked = hit("notes/body-revoked.md");
    const recallRevoked = hit("inbox/recall-revoked.md", { kind: "inbox" });
    const survivor = hit("notes/survivor.md");
    const next = hit("notes/next.md");
    const waiting = deferred<KnowledgeAgentSearchResult>();
    const started = deferred<void>();
    let bodyAllowed = true;
    const source = fakeIndex(async (_request, index) => {
      if (index === 0) return page([bodyRevoked, recallRevoked, survivor], "p2");
      started.resolve();
      return waiting.promise;
    }, relativePath => bodyAllowed || relativePath !== bodyRevoked.vaultRelativePath);
    try {
      const pending = collect(source.index, { maxCandidates: 4 });
      await started.promise;
      bodyAllowed = false;
      bindings.roles.inbox.enabled = false;
      waiting.resolve(page([next]));
      const result = await pending;
      assert.deepEqual(result.candidates.map(candidate => candidate.hit), [survivor, next]);
      assert.deepEqual(result.candidates.map(candidate => candidate.note.id), ["n0", "n1"]);
      assert.equal(result.scannedHits, 4);
      assert.equal(result.stopReason, "exhausted");
      assert.equal(source.reads.count, 0);
    } finally { release(); }
  });

  await run("default 25 notes and maximum 30 stop without reading page tails", async () => {
    const hits = Array.from({ length: 50 }, (_, index) => hit(`notes/${index}.md`));
    for (const [maxCandidates, expected] of [[undefined, 25], [100, 30]] as const) {
      const source = fakeIndex([page(hits, "unneeded")]);
      const result = await collect(source.index, { maxCandidates });
      assert.equal(result.candidates.length, expected);
      assert.equal(result.scannedHits, expected);
      assert.equal(result.pages, 1);
      assert.equal(result.stopReason, "candidate_limit");
      assert.equal(source.requests.length, 1);
    }
  });

  await run("default hit budget is 250, including duplicate hits", async () => {
    const duplicate = hit("notes/repeated.md");
    const source = fakeIndex((_request, index) => page(Array(50).fill(duplicate), `p${index + 1}`));
    const result = await collect(source.index);
    assert.equal(result.scannedHits, 250);
    assert.equal(result.pages, 5);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.stopReason, "scan_budget");
    assert.deepEqual(source.requests.map(request => request.limit), [50, 50, 50, 50, 50]);
  });

  await run("remaining hit budget limits each search page", async () => {
    const duplicate = hit("notes/repeated.md");
    const source = fakeIndex((request, index) => page(Array(request.limit!).fill(duplicate), `p${index + 1}`));
    const result = await collect(source.index, { maxScannedHits: 53 });
    assert.deepEqual(source.requests.map(request => request.limit), [50, 3]);
    assert.equal(result.scannedHits, 53);
    assert.equal(result.stopReason, "scan_budget");

    const overReturning = fakeIndex([page(Array.from({ length: 5 }, (_, index) => hit(`notes/overflow-${index}.md`)))]);
    const partial = await collect(overReturning.index, { maxScannedHits: 3 });
    assert.equal(partial.scannedHits, 3);
    assert.equal(partial.candidates.length, 3);
    assert.equal(partial.stopReason, "scan_budget", "an uninspected tail prevents an exhausted claim");
  });

  await run("default 50-page budget bounds empty but advancing pages", async () => {
    const source = fakeIndex((_request, index) => page([], `p${index + 1}`));
    const result = await collect(source.index);
    assert.equal(result.pages, 50);
    assert.equal(result.scannedHits, 0);
    assert.equal(source.requests.length, 50);
    assert.equal(result.stopReason, "scan_budget");
  });

  await run("empty advancing page is followed and an exhausted search is exact", async () => {
    const source = fakeIndex([page([], "p2"), page([hit("notes/end.md")])]);
    const result = await collect(source.index, { maxScannedHits: 1, maxPages: 2 });
    assert.equal(result.pages, 2);
    assert.equal(result.scannedHits, 1);
    assert.equal(result.stopReason, "exhausted", "known exhaustion wins over a simultaneously reached scan budget");
  });

  await run("missing, repeated, and cyclic cursors stop without looping", async () => {
    const scenarios = [
      [page([], "p1"), { ...page([], "missing"), continuationCursor: undefined }],
      [page([], "p1"), page([], "p1")],
      [page([], "p1"), page([], "p2"), page([], "p1")]
    ];
    for (const pages of scenarios) {
      const source = fakeIndex(pages);
      const result = await collect(source.index);
      assert.equal(result.pages, pages.length);
      assert.equal(result.stopReason, "scan_budget");
    }
  });

  await run("full secret redaction precedes UTF-16 clipping and leaves hit intact", async () => {
    const original = hit("notes/secret-source.md", {
      title: `${"题".repeat(110)} sk-abcdefghijklmnopqrstuvwxyz0123456789 end`,
      excerpt: `${"文".repeat(190)} Bearer abcdefghijklmnopqrstuvwxyz0123456789 end`
    });
    const source = fakeIndex([page([original])]);
    const result = await collect(source.index);
    const { note, hit: preserved } = result.candidates[0];
    assert.equal(note.title, redactEchoInkLocalSecretsV1(original.title).slice(0, 120));
    assert.equal(note.excerpt, redactEchoInkLocalSecretsV1(original.excerpt!).slice(0, 200));
    assert(!note.title.includes("sk-"));
    assert(!note.excerpt.includes("abc"));
    assert.strictEqual(preserved, original);
    assert(original.title.includes("sk-abcdefghijklmnopqrstuvwxyz"));
    assert(original.excerpt!.includes("Bearer abcdefghijklmnopqrstuvwxyz"));
    assert(!JSON.stringify(note).includes(original.vaultRelativePath));

    const unicode = fakeIndex([page([hit("notes/unicode.md", { title: "🙂".repeat(80), excerpt: "🙂".repeat(120) })])]);
    const unicodeNote = (await collect(unicode.index)).candidates[0].note;
    assert.equal(unicodeNote.title.length, 120);
    assert.equal(unicodeNote.excerpt.length, 200);
    const boundary = fakeIndex([page([hit("notes/unicode-boundary.md", { title: `${"题".repeat(119)}🙂`, excerpt: `${"文".repeat(199)}🙂` })])]);
    const boundaryNote = (await collect(boundary.index)).candidates[0].note;
    assert.equal(boundaryNote.title, "题".repeat(119));
    assert.equal(boundaryNote.excerpt, "文".repeat(199));
    const noExcerpt = fakeIndex([page([hit("notes/no-excerpt.md", { excerpt: undefined })])]);
    assert.equal((await collect(noExcerpt.index)).candidates[0].note.excerpt, "");
  });

  await run("pre-abort and abort while search waits reject with AbortError", async () => {
    const pre = new AbortController();
    pre.abort();
    const source = fakeIndex([]);
    await assert.rejects(collect(source.index, { signal: pre.signal }), { name: "AbortError" });
    assert.equal(source.requests.length, 0);

    const waiting = deferred<KnowledgeAgentSearchResult>();
    const started = deferred<void>();
    const late = fakeIndex(async request => {
      assert(request.signal);
      started.resolve();
      return waiting.promise;
    });
    const controller = new AbortController();
    const pending = collect(late.index, { signal: controller.signal });
    await started.promise;
    controller.abort();
    assert.equal(late.requests[0].signal!.aborted, true);
    waiting.resolve(page([hit("notes/too-late.md")], "unneeded"));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(late.requests.length, 1);
    assert.equal(late.reads.count, 0);
  });

  await run("search errors propagate and zero budgets do no work", async () => {
    const failure = new Error("search unavailable");
    const source = fakeIndex(() => { throw failure; });
    await assert.rejects(collect(source.index), error => error === failure);
    for (const budget of [{ maxCandidates: 0 }, { maxScannedHits: 0 }, { maxPages: 0 }]) {
      const empty = fakeIndex([]);
      const result = await collect(empty.index, budget);
      assert.equal(result.pages, 0);
      assert.equal(result.scannedHits, 0);
      assert.equal(empty.requests.length, 0);
      assert.equal(result.stopReason, "maxCandidates" in budget ? "candidate_limit" : "scan_budget");
    }
  });

  await run("cooperative deadline returns earlier candidates and stops the port", async () => {
    let active = false;
    const source = fakeIndex(async (request, index) => {
      assert(request.candidateSearch);
      if (index === 0) return page([hit("notes/partial.md")], "waiting");
      active = true;
      try {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
          if (request.signal!.aborted) abort();
          else request.signal!.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      } finally { active = false; }
    });
    const result = await collect(source.index, { timeBudgetMs: 20 });
    assert.equal(result.stopReason, "time_budget");
    assert.equal(result.candidates.length, 1);
    assert.equal(active, false, "the underlying search has unwound before returning");
  });

  await run("one-ranking audit is used instead of treating unique notes as scan count", async () => {
    const source = fakeIndex([{
      ...page([hit("notes/selected.md")]), candidateSearch: { scannedHits: 87, stopReason: "scan_budget" }
    }]);
    const result = await collect(source.index);
    assert.equal(result.scannedHits, 87);
    assert.equal(result.pages, 1);
    assert.equal(result.stopReason, "scan_budget");
    assert.equal(source.requests.length, 1);
    assert.equal((await collect(fakeIndex([]).index, { timeBudgetMs: 0 })).stopReason, "time_budget");
    const late = fakeIndex(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return { ...page([hit("notes/finished-before-return.md")]), candidateSearch: { scannedHits: 1, stopReason: "candidate_limit" as const } };
    });
    const finished = await collect(late.index, { timeBudgetMs: 5 });
    assert.equal(finished.stopReason, "time_budget");
    assert.equal(finished.candidates.length, 1, "a completed ranking's existing candidates survive a deadline during return validation");
  });

  console.log(`Chat Knowledge candidates: PASS (${cases} cases; in-memory pages only, no Vault/API/model).`);
}

function collect(index: CandidateIndex, input: Partial<Parameters<typeof collectChatKnowledgeCandidates>[0]> = {}) {
  return collectChatKnowledgeCandidates({ vaultPath: VAULT_PATH, agentIndex: index, question: "测试问题", ...input });
}

function hit(vaultRelativePath: string, overrides: Partial<KnowledgeAgentSearchHit> = {}): KnowledgeAgentSearchHit {
  return {
    entryId: `entry:${vaultRelativePath}`, vaultRelativePath, title: `标题 ${vaultRelativePath}`,
    kind: "notes", contentRevision: `sha256:${"a".repeat(64)}`, recordedAt: 1,
    verificationStatus: "local_revision_verified", rawSources: [], excerpt: `完整摘录 ${vaultRelativePath}`,
    ...overrides
  };
}

function page(hits: KnowledgeAgentSearchHit[], continuationCursor?: string): KnowledgeAgentSearchResult {
  const hasMore = continuationCursor !== undefined;
  return {
    generation: 1, total: hits.length + (hasMore ? 1 : 0), returned: hits.length,
    remaining: hasMore ? 1 : 0, hasMore, exhausted: !hasMore, hits,
    ...(hasMore ? { continuationCursor } : {})
  };
}

function fakeIndex(
  pages: KnowledgeAgentSearchResult[] | ((request: Readonly<KnowledgeAgentSearchRequest>, index: number) => KnowledgeAgentSearchResult | Promise<KnowledgeAgentSearchResult>),
  allowsPath?: (relativePath: string) => boolean
): { index: CandidateIndex; requests: Readonly<KnowledgeAgentSearchRequest>[]; reads: { count: number } } {
  const requests: Readonly<KnowledgeAgentSearchRequest>[] = [];
  const reads = { count: 0 };
  const unexpectedRead = async (): Promise<never> => { reads.count++; throw new Error("Candidate stage must not read or build references"); };
  const index = {
    search: async (request: Readonly<KnowledgeAgentSearchRequest>) => {
      const offset = requests.length;
      requests.push(request);
      if (typeof pages === "function") return pages(request, offset);
      assert(offset < pages.length, "unexpected extra search page");
      return pages[offset];
    },
    read: unexpectedRead,
    referenceBuilder: { buildReference: unexpectedRead },
    ...(allowsPath ? { bodySearch: {
      allowsPath, scopeKey: () => "candidate-fixture", invalidate: () => {}, dispose: () => {},
      search: unexpectedRead, read: unexpectedRead
    } } : {})
  };
  return { index, requests, reads };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
