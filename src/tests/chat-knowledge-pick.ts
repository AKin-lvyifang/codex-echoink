import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DecisionClient, setDecisionClient, type DecisionFetch } from "../membership/decision-client";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import type { ChatKnowledgeCandidatesResult } from "../knowledge-base/chat-knowledge-candidates";
import { KnowledgeRetriever, KnowledgeReferenceBuilder } from "../knowledge-base/query";
import { createProductionPiKnowledgeRuntime } from "../plugin/pi-production-runtime-composition";
import { ComposerSubmissions, preparationText } from "../types/composer-submission";

const quota = { used: 1, limit: 2, remaining: 1, resetAt: "2099-12-01T00:00:00+08:00", showCount: true };
const client = (fetch: DecisionFetch) => new DecisionClient({ fetch, token: () => "fixture-login", state: () => ({ enabled: true, introSeen: true }) });

export async function runChatKnowledgePickTests(): Promise<void> {
  await quotaAndValidation();
  await productionDelivery();
  await hardTimeout();
  const submissions = new ComposerSubmissions();
  submissions.begin("p", "o", {}, {});
  submissions.stage("p", { stage: "knowledge", status: "active" });
  submissions.stage("p", { stage: "knowledge", status: "active", detail: "selecting_knowledge" });
  assert.equal(submissions.records.get("p")!.stages.filter(stage => stage.stage === "knowledge").length, 1);
  assert.equal(preparationText(submissions.records.get("p")!.stages.at(-1)!, "zh"), "挑选相关笔记…");
  submissions.stage("p", { stage: "knowledge", status: "completed", notePaths: ["wiki/a.md", "wiki/a.md"] });
  assert.equal(preparationText(submissions.records.get("p")!.stages.at(-1)!, "zh"), "读了 1 篇相关笔记");
  console.log("PASS chat knowledge pick: validation, last quota, delivery/budget, fallbacks, cancellation, real 1500ms timeout, one progress row");
}

async function quotaAndValidation() {
  const seen: { endpoint: string; body: any }[] = [];
  let response: unknown = { probabilities: { n0: 0.65 }, threshold: 0.65, quota: { ...quota, used: 2, remaining: 0 } };
  let token = "fixture-login", enabled = true;
  const c = new DecisionClient({ token: () => token, state: () => ({ enabled, introSeen: true }),
    fetch: async (endpoint, _method, body) => {
      seen.push({ endpoint, body });
      if (endpoint.endsWith("/status")) return { status: 200, json: { available: true, tier: "beta", quota, thresholds: { knowledgePick: 0.72 } } };
      if (endpoint.endsWith("/turn")) return { status: 200, json: { knowledge: 0.9, quota: { ...quota, used: 2, remaining: 0 } } };
      if (endpoint.endsWith("/memory")) return { status: 200, json: { probabilities: { m: 1 }, selected: ["m"], threshold: 0.9, quota: { ...quota, used: 2, remaining: 0 } } };
      return { status: 200, json: response };
    } });
  await c.refreshStatus();
  assert.equal(c.thresholds().knowledgePick, 0.72);
  await c.judgeTurn({ turnId: "last", text: "查我的笔记", checks: ["knowledge"] });
  assert.equal(c.ready(), false);
  assert.equal(c.ready("last"), true);
  const input = { turnId: "last", text: "查我的笔记", recent: ["1", "2", "3", "4"],
    notes: [{ id: "n0", title: "标题", excerpt: "摘录", path: "/local/never-send" }] };
  assert.deepEqual(await c.judgeKnowledge(input), { probabilities: { n0: 0.65 }, threshold: 0.65 });
  assert.equal((await c.judgeMemory({ turnId: "last", text: "问题", memories: [{ id: "m", title: "记忆", recallWhen: "" }] }))?.selected[0], "m");
  const sent = seen.find(item => item.endpoint.endsWith("/knowledge"))!.body;
  assert.equal(sent.turnId, "last");
  assert.deepEqual(sent.recent, ["2", "3", "4"]);
  assert.deepEqual(Object.keys(sent.notes[0]), ["id", "title", "excerpt"]);
  for (const bad of [{ probabilities: {}, threshold: 0.65 }, { probabilities: { n0: -1 }, threshold: 0.65 },
    { probabilities: { n0: 1.1 }, threshold: 0.65 }, { probabilities: { n0: "0.9" }, threshold: 0.65 },
    { probabilities: { n0: NaN }, threshold: 0.65 }, { probabilities: { n0: 0.9 } }, { probabilities: { n0: 0.9 }, threshold: 2 }]) {
    response = bad; assert.equal(await c.judgeKnowledge(input), null, "invalid response must fall back, never count as zero selected");
  }
  const before = seen.length;
  assert.equal(await c.judgeKnowledge({ ...input, turnId: "next" }), null);
  token = "another-login"; assert.equal(await c.judgeKnowledge(input), null);
  token = "fixture-login"; enabled = false; assert.equal(await c.judgeKnowledge(input), null);
  assert.equal(seen.length, before, "new turn, changed login and disabled switch remain gated");
  assert.equal(c.takeExhaustedNotice(), quota.resetAt); assert.equal(c.takeExhaustedNotice(), null);
}

async function productionDelivery() {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-pick-delivery-"));
  const original = KnowledgeRetriever.prototype.retrieve;
  try {
    await mkdir(path.join(root, "wiki"));
    const collected: ChatKnowledgeCandidatesResult = { candidates: [], pages: 1, scannedHits: 12, stopReason: "candidate_limit" };
    for (let i = 0; i < 12; i++) {
      const text = `# 来源${i}\n${"每篇都有能核验的长正文。".repeat(160)}第${i}篇`;
      await writeFile(path.join(root, "wiki", `${i}.md`), text);
      collected.candidates.push({ note: { id: `n${i}`, title: `来源${i}`, excerpt: text.slice(0, 200) },
        hit: { entryId: `hit-${i}`, vaultRelativePath: `wiki/${i}.md`, kind: "wiki", title: `来源${i}`,
          excerpt: text, lineStart: 1, lineEnd: 2, contentRevision: `sha256:${createHash("sha256").update(text).digest("hex")}`,
          recordedAt: 1, rawSources: [], verificationStatus: "local_revision_verified" } });
    }
    const legacyReference = await new KnowledgeReferenceBuilder(root).buildReference({ vaultRelativePath: "wiki/0.md", question: "我的笔记" });
    let legacyCalls = 0;
    KnowledgeRetriever.prototype.retrieve = async function(request) {
      legacyCalls++; assert.equal(request.limit, 6); assert.deepEqual(request.explicitPaths, []);
      if (request.signal?.aborted) throw new Error("fallback after stop is forbidden");
      return { status: "ready", shouldInvokePi: true, references: [legacyReference] };
    };
    const runtime = createProductionPiKnowledgeRuntime({ vaultRootPath: root,
      knowledgeAgentIndex: new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, ".index") }),
      knowledgePreferences: {} as never, usage: {} as never });
    const request = { vaultId: "v", conversationId: "c", piSessionId: "s", productRunId: "product-id",
      question: "我的笔记是什么", explicitPaths: [], includeUnrefined: false, decisionTurnId: "decision-id", recent: ["前文"], knowledgePickApproved: true,
      candidates: Promise.resolve(collected) };
    let stages = 0;
    const c = client(async (_endpoint, _method, body) => {
      assert.equal((body as any).turnId, "decision-id");
      return { status: 200, json: { probabilities: Object.fromEntries(collected.candidates.map((candidate, i) => [candidate.note.id, 0.7 + i * 0.02])), threshold: 0.65, quota } };
    });
    setDecisionClient(c);
    const picked = await runtime.retrieveChat!({ ...request, onStage: async () => { stages++; } });
    assert.equal(legacyCalls, 0); assert.equal(stages, 1);
    assert.ok(picked.references.length > 0 && picked.references.length < 10, "whole-note budget drops trailing notes");
    assert.deepEqual(picked.references.map(ref => ref.vaultRelativePath), Array.from({ length: picked.references.length }, (_, i) => `wiki/${11 - i}.md`));
    assert.ok(picked.references.every(ref => ref.excerpt.length > 200), "reference builder uses the full indexed excerpt");
    const delivered = JSON.parse(picked.providerResourceText).sources;
    assert.equal(delivered.length, picked.references.length);
    assert.deepEqual(delivered.map((source: any) => source.vaultRelativePath), picked.references.map(ref => ref.vaultRelativePath));
    assert.equal(picked.retrieval?.returned, picked.references.length);
    assert.ok(Buffer.byteLength(picked.providerResourceText, "utf8") <= 32_000);
    setDecisionClient(client(async () => ({ status: 200, json: { probabilities: Object.fromEntries(collected.candidates.map(c => [c.note.id, 0.1])), threshold: 0.65, quota } })));
    const zero = await runtime.retrieveChat!(request);
    assert.equal(zero.status, "no_evidence"); assert.equal(zero.references.length, 0); assert.equal(legacyCalls, 0);
    assert.match(zero.providerResourceText, /必要时可用 knowledge_search 换词搜索/u);
    for (const fetcher of [async () => ({ status: 404, json: {} }), async () => ({ status: 200, json: { probabilities: {}, threshold: 0.65 } }),
      async () => { throw new Error("offline"); }] satisfies DecisionFetch[]) {
      setDecisionClient(client(fetcher));
      const fallback = await runtime.retrieveChat!(request);
      assert.deepEqual(fallback.references, [legacyReference]);
    }
    assert.equal(legacyCalls, 3);
    let calls = 0;
    const gated = client(async () => { calls++; return { status: 200, json: { available: false, tier: "free", quota: null } }; });
    await gated.refreshStatus(); setDecisionClient(gated); stages = 0;
    await runtime.retrieveChat!({ ...request, onStage: async () => { stages++; } });
    assert.equal(calls, 1); assert.equal(stages, 0); assert.equal(legacyCalls, 4);
    setDecisionClient(c);
    for (const stopReason of ["time_budget", "exhausted"] as const) {
      await runtime.retrieveChat!({ ...request, candidates: Promise.resolve({ ...collected, candidates: [], stopReason }) });
    }
    assert.equal(legacyCalls, 6);
    const collectingAbort = new AbortController();
    const stillCollecting = runtime.retrieveChat!({ ...request, candidates: new Promise<never>(() => {}), signal: collectingAbort.signal });
    collectingAbort.abort();
    await assert.rejects(stillCollecting, { name: "AbortError" });
    assert.equal(legacyCalls, 6, "stopping while awaiting candidates cannot fall back");
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    setDecisionClient(client(async () => { entered(); return await new Promise<never>(() => {}); }));
    const stopped = runtime.retrieveChat!({ ...request, signal: controller.signal });
    await started; controller.abort(); await assert.rejects(stopped, { name: "AbortError" });
    assert.equal(legacyCalls, 6, "stopping cannot invoke the old retriever");
  } finally { setDecisionClient(null); KnowledgeRetriever.prototype.retrieve = original; await rm(root, { recursive: true, force: true }); }
}

async function hardTimeout() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((_req, res) => {
    timer = setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ probabilities: { n0: 1 }, threshold: 0.65, quota })); }, 2_000);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const original = KnowledgeRetriever.prototype.retrieve;
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const c = client(async (endpoint, method, body, _token, signal) => {
      const response = await fetch(base + endpoint, { method, body: JSON.stringify(body), signal });
      return { status: response.status, json: await response.json() };
    });
    let fallbackCalls = 0;
    KnowledgeRetriever.prototype.retrieve = async request => {
      fallbackCalls++; assert.equal(request.limit, 6);
      return { status: "no_evidence", shouldInvokePi: true, references: [], fixedResponse: "" };
    };
    setDecisionClient(c);
    const root = "/synthetic-timeout-fixture";
    const runtime = createProductionPiKnowledgeRuntime({ vaultRootPath: root,
      knowledgeAgentIndex: new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: `${root}/state` }),
      knowledgePreferences: {} as never, usage: {} as never });
    const start = performance.now();
    const result = await runtime.retrieveChat!({ vaultId: "v", conversationId: "c", piSessionId: "s", productRunId: "r", decisionTurnId: "timeout",
      question: "问题", explicitPaths: [], includeUnrefined: false, knowledgePickApproved: true,
      candidates: Promise.resolve({ candidates: [{ note: { id: "n0", title: "标题", excerpt: "摘录" }, hit: { vaultRelativePath: "wiki/a.md" } as never }], pages: 1, scannedHits: 1, stopReason: "exhausted" }) });
    assert.equal(result.status, "no_evidence"); assert.equal(fallbackCalls, 1, "the actual production preflight falls back at the hard deadline");
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 1_450 && elapsed < 1_850, `real server exceeded 1500ms: ${elapsed}`);
    console.log(`1500ms timeout measured ${elapsed.toFixed(1)}ms (server delays 2000ms)`);
  } finally { setDecisionClient(null); KnowledgeRetriever.prototype.retrieve = original;
    if (timer) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
